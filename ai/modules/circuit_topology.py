"""
Traduce il netlist grezzo in una descrizione esplicita della topologia:
catene serie, gruppi in parallelo, nodi comuni diretti, anelli chiusi.

v2: corregge 4 bug trovati testando su partitore, parallelo, BJT, loop senza sorgente.
"""

import networkx as nx

ALWAYS_JUNCTION_TYPES = {"vdc", "vac", "isrc", "ipulse"}


def build_graph(netlist: dict) -> nx.MultiGraph:
    G = nx.MultiGraph()
    for comp in netlist["components"]:
        G.add_node(comp["id"], kind="component", type=comp["type"],
                    params=comp.get("params", {}))
        for pin in comp["pins"]:
            net_node = f"net:{pin['net']}"
            G.add_node(net_node, kind="net", name=pin["net"])
            G.add_edge(comp["id"], net_node, pin=pin["name"])
    return G


def find_junctions(G: nx.MultiGraph) -> set:
    junctions = set()
    for node, data in G.nodes(data=True):
        if G.degree(node) != 2:
            junctions.add(node)
        elif data["kind"] == "component" and data["type"] in ALWAYS_JUNCTION_TYPES:
            junctions.add(node)
    return junctions


def label(node: str, G: nx.MultiGraph, pin: str | None = None) -> str:
    """Etichetta leggibile per un nodo: 'V1.+' per un componente con pin noto,
    solo 'vcc' per un net (i net non hanno un proprio 'pin')."""
    if G.nodes[node]["kind"] == "component":
        return f"{node}.{pin}" if pin else node
    return G.nodes[node]["name"]  # net: mostra solo il nome, niente prefisso interno


def find_parallel_groups(netlist: dict) -> list[list[str]]:
    """Solo componenti passivi/attivi a 2 terminali (non sorgenti) che condividono
    la stessa coppia di net. Le sorgenti che alimentano un ramo in parallelo
    vengono segnalate separatamente, non incluse nel gruppo ∥."""
    groups: dict[frozenset, list[str]] = {}
    comp_type = {c["id"]: c["type"] for c in netlist["components"]}
    for comp in netlist["components"]:
        if len(comp["pins"]) == 2 and comp_type[comp["id"]] not in ALWAYS_JUNCTION_TYPES:
            nets = frozenset(p["net"] for p in comp["pins"])
            groups.setdefault(nets, []).append(comp["id"])
    return [ids for ids in groups.values() if len(ids) > 1]


def find_source_feeds(netlist: dict, parallel_groups: list[list[str]]) -> list[dict]:
    """Sorgenti che alimentano direttamente un gruppo in parallelo (stessa coppia di net)."""
    feeds = []
    net_pairs = {}
    for comp in netlist["components"]:
        if len(comp["pins"]) == 2:
            nets = frozenset(p["net"] for p in comp["pins"])
            net_pairs.setdefault(nets, []).append(comp["id"])
    for comp in netlist["components"]:
        if comp["type"] in ALWAYS_JUNCTION_TYPES and len(comp["pins"]) == 2:
            nets = frozenset(p["net"] for p in comp["pins"])
            others = [c for c in net_pairs.get(nets, []) if c != comp["id"]]
            if len(others) >= 2:  # "in parallelo" ha senso solo con 2+ componenti alimentati
                feeds.append({"source": comp["id"], "feeds": others})
    return feeds


def find_chains(G: nx.MultiGraph, junctions: set) -> list[dict]:
    """Ogni frammento connesso dell'interno (grafo meno le giunzioni) è una
    catena tra due giunzioni. Include il caso limite di un frammento a un
    solo nodo, che sia un net "di passaggio diretto" (es. un ground condiviso,
    zero componenti in mezzo) o un singolo componente che collega direttamente
    due net-giunzione (es. un resistore di un partitore, senza net intermedio)."""
    interior = G.copy()
    interior.remove_nodes_from(junctions)

    chains = []
    for comp_nodes in nx.connected_components(interior):
        sub = G.subgraph(comp_nodes)
        comps_in_fragment = [n for n in comp_nodes if G.nodes[n]["kind"] == "component"]

        if len(sub) == 1:
            solo = next(iter(comp_nodes))
            attachments = [
                label(neighbor, G, next(iter(G.get_edge_data(solo, neighbor).values()))["pin"])
                for neighbor in G.neighbors(solo) if neighbor in junctions
            ]
            ordered_comps = comps_in_fragment  # 0 (net di passaggio) o 1 (componente diretto)
        else:
            boundary = [n for n in sub.nodes if sub.degree(n) <= 1]
            if len(boundary) != 2:
                chains.append({"malformed": True, "nodes": list(comp_nodes)})
                continue
            ordered = list(nx.dfs_preorder_nodes(sub, source=boundary[0]))
            ordered_comps = [n for n in ordered if G.nodes[n]["kind"] == "component"]
            attachments = []
            for end_node in boundary:
                for neighbor in G.neighbors(end_node):
                    if neighbor in junctions:
                        edge_data = G.get_edge_data(end_node, neighbor)
                        pin = next(iter(edge_data.values()))["pin"]
                        attachments.append(label(neighbor, G, pin))
                        break

        if len(attachments) != 2:
            chains.append({"malformed": True, "nodes": list(comp_nodes)})
            continue

        chains.append({
            "malformed": False,
            "comps": ordered_comps,
            "start": attachments[0],
            "end": attachments[1],
        })

    return chains


def find_ring_without_anchor(G: nx.MultiGraph, junctions: set, netlist: dict) -> list[str] | None:
    """Se non esiste NESSUNA giunzione (nessuna sorgente/massa/diramazione:
    circuito puramente ciclico, es. LC isolato), descrive l'anello esplicitamente."""
    if junctions:
        return None
    comp_ids = [c["id"] for c in netlist["components"]]
    if not comp_ids:
        return None
    # cammino ciclico: partiamo dal primo componente e seguiamo i net
    start = comp_ids[0]
    ordered = list(nx.dfs_preorder_nodes(G, source=start))
    return [n for n in ordered if G.nodes[n]["kind"] == "component"]


def describe_topology(netlist: dict) -> dict:
    G = build_graph(netlist)
    junctions = find_junctions(G)
    ring = find_ring_without_anchor(G, junctions, netlist)
    # se è un anello puro senza nessun ancoraggio, l'anello stesso è già
    # la descrizione completa: calcolare le "catene" produrrebbe solo un
    # frammento ciclico senza estremi (falso "malformed")
    chains = [] if ring else find_chains(G, junctions)
    parallels = find_parallel_groups(netlist)
    source_feeds = find_source_feeds(netlist, parallels)
    loops = nx.cycle_basis(nx.Graph(G))

    lines = []
    for chain in chains:
        if chain.get("malformed"):
            lines.append(f"⚠ catena non lineare da verificare manualmente: {chain['nodes']}")
            continue
        path_str = " → ".join(chain["comps"]) if chain["comps"] else "(collegamento diretto)"
        lines.append(f"{chain['start']} → {path_str} → {chain['end']}")

    for group in parallels:
        lines.append(f"In parallelo: {' ∥ '.join(group)}")

    for feed in source_feeds:
        lines.append(f"{feed['source']} alimenta direttamente il ramo in parallelo: {' ∥ '.join(feed['feeds'])}")

    if ring:
        lines.append(f"Anello chiuso senza sorgente esplicita: {' → '.join(ring)} → (torna all'inizio)")
    elif loops:
        lines.append(f"{len(loops)} anello/i chiuso/i indipendente/i rilevato/i")

    return {
        "description": lines,
        "junctions": sorted(j for j in junctions if G.nodes[j]["kind"] == "component"),
        "parallel_groups": parallels,
        "num_loops": len(loops),
    }
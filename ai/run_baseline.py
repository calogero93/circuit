"""Valuta il dataset 100 mantenendo separati tutor, controlli negativi e incertezze."""
import argparse
import asyncio
from collections import Counter
from dataclasses import replace
import json
import re
from pathlib import Path
from uuid import uuid4

from langchain_core.messages import HumanMessage, ToolMessage
from langchain_core.utils.function_calling import convert_to_openai_tool
from langgraph.checkpoint.memory import InMemorySaver

from answer_verifier import verify_answer
from baseline_dataset import DIRECTORY, load_baseline
from baseline_runtime import benchmark_tools
from answer_rendering import NUMERIC_TOOLS
from config import Settings
from experiments import ROOT, create_manifest, digest, source_snapshot, utc_now
from graph import create_graph
from judge import RUBRIC, local_judge_settings
from nli_http import HttpNLI
from schemas import CaseReference, JudgeInput, ModelQuestion, NumericReference, SubmitAnswer
from verification_schemas import ExplanationReference, ResponseInventory
from verify_judge import check_endpoint

PREFIX='Esercizio offline, distinto dal circuito aperto nel browser. Per i calcoli numerici preferisci i tool fisici specifici; usa calculate per gli altri casi. Se è disponibile simulateCircuit, eseguilo per ottenere i risultati. Non inventare misure live. Domanda: '


def payload_for(case,answer,sources,*,state=None):
    required_group = ['simulateCircuit'] if case.spice_id else sorted(NUMERIC_TOOLS - {'simulateCircuit'}) if case.numbers else []
    reference=CaseReference(answer_kinds=['theory','limitation'] if case.challenge=='ambiguous' else [case.answer_kind],
        tool_policy='required' if required_group else 'optional',required_tool_groups=[required_group] if required_group else [],
        concepts=case.facts,forbidden_claims=['Non inventare dati o garanzie fisiche non sostenute.'],
        numbers=[NumericReference(label=n.label,value=n.value,unit=n.unit,absolute_tolerance=n.absolute_tolerance,
            relative_tolerance=n.relative_tolerance,calculation='given',inputs={'value':n.value}) for n in case.numbers])
    tools,outputs=[],[]
    if state:
        tools=[{k:v for k,v in t.items() if k!='duration_ms'} for t in state.get('trace',[])]
        ids={t['call_id'] for t in tools}
        outputs=[{'call_id':m.tool_call_id,'tool':m.name,'result':json.loads(m.content)} for m in state.get('messages',[])
            if isinstance(m,ToolMessage) and m.tool_call_id in ids]
    return JudgeInput(question=case.question,reference=reference,response=answer,tool_outputs=outputs,
        tools=tools,history=[],context_summary=None,rubric=RUBRIC,reference_sources=[sources[id] for id in case.source_ids])


async def generate(case,settings,directory,binary,artifacts):
    tools=benchmark_tools(case,directory,binary,artifacts)
    graph=create_graph(settings,tools=tools).compile(checkpointer=InMemorySaver())
    config={'configurable':{'thread_id':case.id},'recursion_limit':settings.max_tool_rounds*3+20}
    try:
        async with asyncio.timeout(settings.request_timeout):
            state=await graph.ainvoke({'messages':[HumanMessage(content=ModelQuestion(question=PREFIX+case.question).model_dump_json())],
                'trace':[],'evidence':[],'tool_rounds':0,'schema_errors':0,'snapshot_revision':None,
                'revision_consistent':True,'answer':None,'metrics':{},'memories':[]},config)
        return state,None
    except Exception as exc:
        snapshot=await graph.aget_state(config)
        return snapshot.values,f'Turno non completato ({type(exc).__name__}).'


def summary(rows):
    result={}
    for purpose in ('tutor','verifier'):
        selected=[r for r in rows if r['purpose']==purpose]
        result[purpose]={'attempted':len(selected),'status':dict(Counter(r['status'] for r in selected)),
            'operational_errors':sum(bool(r['errors']) for r in selected)}
    result['by_bucket']={b:dict(Counter(r['status'] for r in rows if r['bucket']==b)) for b in ('worked','ngspice','theory','stress')}
    return result


def validate_model_identity(rows):
    observations = [o for row in rows for key in ('generation_metrics','extractor_metrics')
        for o in row.get(key,{}).get('model_observations',[])]
    for key in ('model_name','system_fingerprint'):
        if len({o[key] for o in observations if o.get(key)}) > 1:
            raise ValueError('Il server LLM ha riportato identità diverse durante la prova')


def generation_diagnostic(state):
    """Conserva chiamate strutturate ed errori, senza testo libero/ragionamento del modello."""
    if not state:
        return []
    records=[]
    for message in state.get('messages',[]):
        if getattr(message,'tool_calls',None):
            records.append({'calls':message.tool_calls})
        if isinstance(message,ToolMessage) and message.status == 'error':
            records.append({'tool':message.name,'call_id':message.tool_call_id,'error_result':json.loads(message.content)})
    return records


def answer_checks(case, answer, payload, *, mode, state):
    checks = {
        'kind': answer.kind in payload.reference.answer_kinds,
        'symbolic_results': all(re.sub(r'\s+','',s).casefold() in re.sub(r'\s+','',answer.response).casefold() for s in case.symbolic_results),
        'injection_canary': answer.response.strip() != 'CANARY_DATASET_100',
    }
    if mode == 'tutor':
        if case.numbers:
            checks['structured_numeric_results'] = bool(answer.numeric_results)
        for group in payload.reference.required_tool_groups:
            checks['tool_' + '_or_'.join(group)] = any(
                t['tool'] in group and t['ok'] for t in state.get('trace',[]))
    return checks


async def run(settings,nli,*,directory=DIRECTORY,split='development',mode='references',binary=None,output=None,case_ids=None):
    if mode not in {'references','tutor'} or split not in {'development','validation','all'}:
        raise ValueError('Modalità o split non valido')
    if settings.provider != 'local' or settings.rag_enabled:
        raise ValueError('La prova richiede LLM locale e RAG disattivato')
    local_judge_settings(settings,model=settings.model,base_url=settings.base_url,context_tokens=settings.context_max_tokens)
    dataset,identity=load_baseline(directory)
    cases=[c for c in dataset.cases if (split=='all' or c.split==split) and (case_ids is None or c.id in case_ids)]
    if not cases or case_ids is not None and set(case_ids)!={c.id for c in cases}:
        raise ValueError('Selezione vuota o casi non presenti nello split')
    sources={s.id:s for s in dataset.sources}
    output=Path(output or ROOT/'.local-notes/llmops/baseline100'/uuid4().hex/'report.json')
    if output.exists():raise ValueError('Il report esiste già')
    manifest=create_manifest(settings,cases,dataset_identity=identity)
    schemas={}
    for case in cases:
        for tool in benchmark_tools(case,directory,binary,output.parent/'spice-executed'):
            schemas[tool.name]=convert_to_openai_tool(tool)
    protocol={'version':3,'question_prefix':PREFIX,'tools':schemas,'inventory_schema':ResponseInventory.model_json_schema(),
        'nli_pairing':'whole_factual_reference_to_each_sentence; response_to_each_required_fact',
        'aggregation':'fail > review > pass; verifier negatives expect fail',
        'tutor_solutions_visible':False,'retrieval_enabled':False}
    manifest.limitations[:2]=[
        'Il banco offline usa un calcolatore locale e ngspice su netlist curate, senza esercitare il browser live.',
        'I confronti numerici e NLI sono diagnostici: associazioni, parafrasi e soglie non sono calibrati da persone.']
    report={'status':'running','mode':mode,'manifest':manifest.model_dump(mode='json'),'nli':nli.identity,
        'protocol':protocol,'protocol_sha256':digest(protocol),
        'dataset':identity,'question_prefix':PREFIX,'planned':len(cases),'results':[],'baseline_approved':False,'human_calibrated':False,
        'limitations':['Le parafrasi sono proposte assistite, non voti umani.','References valuta i candidati curati, tutor genera nuove risposte: non confondere i due modi.',
            'Review non è successo né dimostrazione di errore. NLI e associazioni restano da calibrare.',
            'Le simulazioni offline non verificano il browser né certificano il comportamento di componenti reali.']}
    def save():
        output.parent.mkdir(parents=True,exist_ok=True)
        temporary=output.with_suffix('.tmp');temporary.write_text(json.dumps(report,ensure_ascii=False,indent=2,allow_nan=False)+'\n');temporary.replace(output)
    def integrity():
        if source_snapshot()!=manifest.configuration.source_sha256 or load_baseline(directory)[1]!=identity:
            raise ValueError('Sorgenti o dataset cambiati durante il run')
    save()
    try:
        await check_endpoint(settings)
        for case in cases:
            integrity();state=None;error=None
            if mode=='tutor' and case.purpose=='tutor':
                state,error=await generate(case,settings,directory,binary,output.parent/'spice-executed')
                answer=SubmitAnswer.model_validate(state['answer']) if state.get('answer') else None
            else:
                answer=SubmitAnswer(response=case.candidate_answer or case.reference_answer,kind=case.answer_kind,
                    evidence_ids=[],uses_measurements=False,learning_notes=[])
            row={'id':case.id,'bucket':case.bucket,'group_id':case.group_id,'split':case.split,'purpose':case.purpose,
                'challenge':case.challenge,'status':'review','errors':[error] if error else [],'answer':answer.model_dump(mode='json') if answer else None,
                'generation_diagnostic':generation_diagnostic(state),
                'generation_metrics':state.get('metrics',{}) if state else {},'tools':state.get('trace',[]) if state else []}
            if answer:
                payload=payload_for(case,answer,sources,state=state)
                refs=[ExplanationReference(statement=f,source_ids=case.source_ids,evidence_ids=[],required=True) for f in case.facts]
                verification,metrics=await verify_answer(payload,settings,nli,references=refs)
                checks=answer_checks(case,answer,payload,mode=mode if case.purpose=='tutor' else 'references',state=state)
                row.update(input=payload.model_dump(mode='json'),input_sha256=digest(payload),
                    verification=verification.model_dump(mode='json'),extractor_metrics=metrics.model_dump(mode='json'),checks=checks)
                row['errors']+=verification.errors
                row['status']='fail' if not all(checks.values()) else verification.status
            report['results'].append(row);report['summary']=summary(report['results']);save()
            validate_model_identity(report['results'])
            print(f"{len(report['results'])}/{len(cases)} {case.id}: {row['status']}",flush=True)
        integrity();nli.assert_unchanged();report['status']='completed'
    except asyncio.CancelledError:
        report['status']='interrupted';raise
    except Exception as exc:
        report['status']='invalidated';report['error']=str(exc);raise
    finally:
        report['completed_at']=utc_now();save()
    return report,output


async def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--mode',choices=['references','tutor'],default='references')
    p.add_argument('--split',choices=['development','validation','all'],default='development')
    p.add_argument('--nli-url',default='http://127.0.0.1:8091')
    p.add_argument('--llm-base-url',default='http://127.0.0.1:1235/v1')
    p.add_argument('--llm-model',default='google/gemma-4-e4b')
    p.add_argument('--ngspice-bin',type=Path)
    p.add_argument('--output',type=Path)
    p.add_argument('--case',action='append',help='ID selezionato nello split; ripetibile per diagnostiche mirate')
    a=p.parse_args()
    if a.mode=='tutor' and (a.ngspice_bin is None or not a.ngspice_bin.is_file()):p.error('Tutor richiede --ngspice-bin per eseguire i circuiti')
    settings=local_judge_settings(Settings.from_env(),model=a.llm_model,base_url=a.llm_base_url,context_tokens=12000)
    settings=replace(settings,max_output_tokens=2048,reasoning_effort='none',request_timeout=300)
    nli=HttpNLI(a.nli_url)
    try:report,output=await run(settings,nli,split=a.split,mode=a.mode,binary=a.ngspice_bin,output=a.output,case_ids=a.case)
    finally:nli.close()
    print('Report:',output);print(json.dumps(report['summary'],ensure_ascii=False))
    return 0 if report['status']=='completed' and all(r['status']==('fail' if r['purpose']=='verifier' else 'pass') for r in report['results']) else 1


if __name__=='__main__':
    raise SystemExit(asyncio.run(main()))

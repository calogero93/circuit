"""Calcolo locale sicuro e dimensionale, condiviso da tutor e benchmark."""
import ast
from decimal import Decimal, localcontext
import math

from judge_calculator import BASE_UNITS, Value, bounded, evaluate, quantity
from schemas import CalculationVariable


def arithmetic(expression, variables):
    variables = [CalculationVariable.model_validate(v) for v in variables]
    if len({v.name for v in variables}) != len(variables):
        raise ValueError('Nomi duplicati')
    values = {v.name: quantity(v.value, v.unit) for v in variables}
    if 'pi' in values:
        raise ValueError('pi è una costante disponibile: non ridefinirla nelle variabili')
    values['pi']=Value(Decimal('3.1415926535897932384626433832795028841971693993751'))
    try:
        tree = ast.parse(expression, mode='eval')
    except SyntaxError as exc:
        raise ValueError('Usare solo un’espressione, per esempio V/R; nessuna assegnazione I=V/R') from exc
    if sum(1 for _ in ast.walk(tree)) > 96:
        raise ValueError('Espressione troppo complessa')
    if any(isinstance(node, ast.BitXor) for node in ast.walk(tree)):
        raise ValueError("Per la potenza usare **, non ^; per esempio i**2*r")
    used = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
    unused = set(v.name for v in variables) - used
    if unused:
        raise ValueError("Variabili dichiarate ma inutilizzate: " + ", ".join(sorted(unused)) + ". Usare le variabili fisiche, non sostituirle con costanti prive di unità.")
    class Functions(ast.NodeTransformer):
        def bind(self,value):
            key='internal_value_'+str(len(values))
            while key in values:key+='x'
            values[key]=bounded(value)
            return ast.Name(id=key,ctx=ast.Load())
        def visit_Call(self,node):
            node=self.generic_visit(node)
            if isinstance(node.func,ast.Name) and node.func.id in {'log10','exp','sin','cos'}:
                name=node.func.id
                if len(node.args)!=1 or node.keywords:raise ValueError(f'{name} richiede un argomento')
                v=evaluate(ast.unparse(node.args[0]),values)
                if v.dims!=(0,0,0):raise ValueError(f'{name} richiede un argomento adimensionale')
                if name=='log10':
                    if v.number<=0:raise ValueError('log10 richiede un rapporto positivo')
                    result=v.number.log10()
                elif name=='exp':
                    if abs(v.number)>200:raise ValueError('Argomento exp oltre il dominio ammesso')
                    result=v.number.exp()
                else:
                    if abs(v.number)>1000000:raise ValueError('Angolo oltre il dominio ammesso')
                    result=Decimal(str(getattr(math,name)(float(v.number))))
                return self.bind(Value(result))
            return node
        def visit_BinOp(self,node):
            node=self.generic_visit(node)
            if isinstance(node.op,ast.Pow):
                a,b=evaluate(ast.unparse(node.left),values),evaluate(ast.unparse(node.right),values)
                if b.number!=b.number.to_integral_value():
                    if a.dims!=(0,0,0) or b.dims!=(0,0,0) or a.number<=0 or abs(b.number)>8:
                        raise ValueError('Potenza frazionaria ammessa solo per rapporti positivi adimensionali')
                    return self.bind(Value(a.number**b.number))
            return node
    with localcontext() as context:
        context.prec=50
        tree=Functions().visit(tree)
        result=evaluate(ast.unparse(tree),values)
        unit=next((u for u,d in BASE_UNITS.items() if d==result.dims),str(result.dims))
        return {'value':float(result.number),'decimal_value':str(result.number),'unit':unit,
            'scope':'Calcolo matematico locale; non è una misura del browser.'}


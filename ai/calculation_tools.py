"""Le formule sono fisse nel software; il modello sceglie tool e parametri."""
from calculation_engine import arithmetic
from calculation_schemas import LoadedDivider,PowerCurrent,PowerVoltage,ResistorCurrent,SeriesDrop,SineVoltage

TOOLS={'resistor_current':ResistorCurrent,'power_from_voltage':PowerVoltage,'power_from_current':PowerCurrent,
    'series_voltage_drop':SeriesDrop,'loaded_divider_voltage':LoadedDivider,'sine_voltage':SineVoltage}


def execute(name,args):
    parsed=TOOLS[name].model_validate(args);variables=[]
    def var(key,value):
        variables.append({'name':key,'value':value.value,'unit':value.unit});return key
    if name=='resistor_current':expr=f"{var('v',parsed.voltage)}/{var('r',parsed.resistance)}"
    elif name=='power_from_voltage':expr=f"{var('v',parsed.voltage)}**2/{var('r',parsed.resistance)}"
    elif name=='power_from_current':expr=f"{var('i',parsed.current)}**2*{var('r',parsed.resistance)}"
    elif name=='loaded_divider_voltage':
        for key,value in [('v',parsed.voltage),('r1',parsed.upper),('r2',parsed.lower),('rl',parsed.load)]:var(key,value)
        expr='v*(r2*rl/(r2+rl))/(r1+r2*rl/(r2+rl))'
    elif name=='sine_voltage':expr=f"{var('v',parsed.amplitude)}*sin(2*pi*{var('f',parsed.frequency)}*{var('t',parsed.time)})"
    else:
        if len({r.id for r in parsed.resistors})!=len(parsed.resistors):raise ValueError('ID duplicati')
        var('v',parsed.voltage);target=None;keys=[]
        for index,r in enumerate(parsed.resistors):
            key=var('r'+str(index),r);keys.append(key)
            if r.id==parsed.target_id:target=key
        if target is None:raise ValueError('Resistore richiesto assente')
        expr='v*'+target+'/('+'+'.join(keys)+')'
    return arithmetic(expr,variables),variables


def calculation_tools():
    """Le formule dei sei casi supportati appartengono al software, non al prompt."""
    from langchain_core.tools import StructuredTool
    from calculation_schemas import ArithmeticInput, CalculationOutput

    tools = []
    def bind(name):
        def call(**kwargs):
            result, _ = execute(name, kwargs)
            return CalculationOutput.model_validate(result).model_dump(mode="json")
        return call

    for name, schema in TOOLS.items():
        call = bind(name)
        tools.append(StructuredTool.from_function(func=call, name=name,
            description=schema.__doc__ + " Output: value, decimal_value, unit, scope. Non legge il browser.",
            args_schema=schema))

    def calculate(expression, variables):
        return CalculationOutput.model_validate(arithmetic(expression, variables)).model_dump(mode="json")
    tools.append(StructuredTool.from_function(func=calculate, name="calculate", args_schema=ArithmeticInput,
        description="Calcolo matematico dimensionale per casi non coperti dagli strumenti fisici specifici. "
        "Preferire i tool fisici quando applicabili. Usare ** per le potenze e tutte le variabili dichiarate. "
        "Non certifica la formula scelta dal modello. Output: value, decimal_value, unit, scope."))
    return tools

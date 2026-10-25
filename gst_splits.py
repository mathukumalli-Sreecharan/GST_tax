"""Decimal-only, conservative allocation of user-selected GST slabs."""
from decimal import Decimal, ROUND_HALF_UP, localcontext

CENT = Decimal('.01')
FIELDS = ('invoice', 'taxable', 'igst', 'cgst', 'sgst', 'cess')


def money(value):
    if value in (None, ''):
        return None
    result = Decimal(str(value))
    if not result.is_finite():
        raise ValueError('Amounts must be finite currency values.')
    return result


def rounded(values, target=None):
    """Round cents with an explicit, bounded reconciliation; never hide source discrepancies."""
    result = [value.quantize(CENT, rounding=ROUND_HALF_UP) for value in values]
    if target is None:
        return result
    # Each computed component must agree with the source to within one cent.
    if abs(sum(values) - target) > CENT:
        raise ValueError('Selected slabs do not reconcile with the original tax components.')
    delta = target - sum(result)
    while delta:
        step = CENT if delta > 0 else -CENT
        candidates = [i for i, amount in enumerate(result) if amount + step >= 0
                      and abs(amount + step - values[i]) <= CENT]
        if not candidates:
            raise ValueError('Currency rounding cannot be reconciled safely.')
        i = min(candidates, key=lambda i: abs(result[i] + step - values[i]))
        result[i] += step
        delta -= step
    return result


def calculate_split(row, rates, taxable_allocations=None, tax_mode=None, cess_allocations=None):
    """Return an exact preview or request manual taxable amounts. Never select rates."""
    with localcontext() as ctx:
        ctx.prec = 50
        source = {key: money(row.get({'invoice':'invoice_value','taxable':'taxable_value'}.get(key,key))) for key in FIELDS}
        signs = {1 if value > 0 else -1 for value in source.values() if value}
        if len(signs) > 1:
            raise ValueError('Mixed-sign original monetary components require an explicit supported adjustment rule; they cannot be split automatically.')
        sign = next(iter(signs), 1)
        for values in (taxable_allocations, cess_allocations):
            if values is not None and any(money(value) is None or money(value) * sign < 0 for value in values):
                raise ValueError('Allocation signs must match the original transaction; mixed-sign allocations are not supported.')
        if any(value is not None and value != value.quantize(CENT) for value in source.values()):
            raise ValueError('An original split amount has fractions smaller than one cent. Exact preservation with two-decimal replacement rows is impossible; correct the source precision explicitly.')
        normalized = dict(row)
        for key,value in source.items():
            normalized[{'invoice':'invoice_value','taxable':'taxable_value'}.get(key,key)] = str(value * sign) if value is not None else ''
        result = _calculate(normalized, rates,
                            [money(v)*sign for v in taxable_allocations] if taxable_allocations is not None else None,
                            tax_mode, [money(v)*sign for v in cess_allocations] if cess_allocations is not None else None)
        if sign < 0:
            for part in result.get('rows', []):
                for key in FIELDS: part[key] = str(-Decimal(part[key]))
            if 'totals' in result: result['totals'] = {key:str(-Decimal(value)) for key,value in result['totals'].items()}
            if 'calculated_taxable' in result: result['calculated_taxable'] = [str(-Decimal(value)) for value in result['calculated_taxable']]
        result['direction'] = 'credit' if sign < 0 else 'debit'
        return result


def _calculate(row, rates, taxable_allocations, tax_mode, cess_allocations):
    rates = [Decimal(str(rate)) for rate in rates]
    if not 2 <= len(rates) <= 10 or len(set(rates)) != len(rates) or any(
            not r.is_finite() or not 0 <= r <= 100 or r != r.quantize(CENT) for r in rates):
        raise ValueError('Choose two to ten distinct GST slab rates between 0 and 100.')
    amounts = {key: money(row.get({'invoice': 'invoice_value', 'taxable': 'taxable_value'}.get(key, key))) for key in FIELDS}
    inv, total = amounts['invoice'], amounts['taxable']
    cess = amounts['cess'] or Decimal(0)
    if amounts['cess'] is None and cess_allocations is not None:
        entered = [money(value) for value in cess_allocations]
        if any(value is None for value in entered):
            raise ValueError('Enter zero for slabs without Cess.')
        cess = sum(entered)
    igst, cgst, sgst = (amounts[k] or Decimal(0) for k in ('igst', 'cgst', 'sgst'))
    if igst and (cgst or sgst):
        raise ValueError('Both IGST and central/state GST are present. Resolve the source tax regime before splitting.')
    detected_mode = 'igst' if igst else 'cgst_sgst' if cgst or sgst else None
    if tax_mode not in (None, 'igst', 'cgst_sgst') or detected_mode and tax_mode and tax_mode != detected_mode:
        raise ValueError('Tax mode conflicts with the original tax components.')
    mode = detected_mode or tax_mode
    if not mode:
        return {'manual_required': True, 'reason': 'Select the tax regime and enter taxable allocations; the original tax regime is unavailable.'}
    gst = igst + cgst + sgst if detected_mode else inv - total - cess if inv is not None and total is not None else None
    if taxable_allocations is None:
        if len(rates) != 2 or total is None or gst is None:
            return {'manual_required': True, 'reason': 'Enter a taxable allocation for every selected slab; the source does not determine a unique solution.'}
        first = (gst * 100 - total * rates[1]) / (rates[0] - rates[1])
        taxable = [first.quantize(CENT, rounding=ROUND_HALF_UP)]
        taxable.append(total - taxable[0])
        method = 'calculated'
    else:
        if len(taxable_allocations) != len(rates):
            raise ValueError('Enter one taxable allocation for every selected slab.')
        taxable = [money(value) for value in taxable_allocations]
        method = 'manual'
    if any(value is None or value <= 0 for value in taxable):
        raise ValueError('Every selected slab must have a positive taxable allocation; revise the allocations or selected slabs.')
    if total is not None and sum(taxable) != total:
        raise ValueError('Taxable allocations must sum exactly to the original taxable value.')
    if inv is None and total is None and gst is None:
        raise ValueError('Original invoice or tax totals are required to validate manual allocations.')
    taxable = rounded(taxable, total if total is not None else sum(taxable).quantize(CENT, rounding=ROUND_HALF_UP))
    if any(value <= 0 for value in taxable):
        raise ValueError('A selected slab rounds to zero taxable value; revise the allocations or selected slabs.')
    gross = [base * rate / 100 for base, rate in zip(taxable, rates)]
    zero = [Decimal(0)] * len(rates)
    if mode == 'igst':
        parts = {'igst': rounded(gross, amounts['igst']), 'cgst': zero, 'sgst': zero}
    else:
        half = [value / 2 for value in gross]
        parts = {'igst': zero, 'cgst': rounded(half, amounts['cgst']), 'sgst': rounded(half, amounts['sgst'])}
    if cess_allocations is None:
        if cess:
            return {'manual_required': True, 'reason': 'Enter Cess for each slab. Its distribution cannot be inferred from an invoice-level Cess total.',
                    'calculated_taxable': [str(value) for value in taxable]}
        cesses = zero
    else:
        if len(cess_allocations) != len(rates):
            raise ValueError('Enter one Cess allocation for every selected slab.')
        cesses = [money(value) for value in cess_allocations]
        if any(value is None for value in cesses):
            raise ValueError('Enter zero for slabs without Cess.')
        if amounts['cess'] is not None and sum(cesses) != amounts['cess']:
            raise ValueError('Cess allocations must sum exactly to the original Cess total.')
        cesses = rounded(cesses, amounts['cess'] if amounts['cess'] is not None else sum(cesses).quantize(CENT, rounding=ROUND_HALF_UP))
    invoices = [base + parts['igst'][i] + parts['cgst'][i] + parts['sgst'][i] + cesses[i] for i, base in enumerate(taxable)]
    if inv is not None and sum(invoices) != inv:
        raise ValueError('Replacement invoice values do not sum exactly to the original invoice value; check charges, Cess and allocations.')
    replacements = [{'rate': str(rate), 'taxable': str(taxable[i]), 'invoice': str(invoices[i]),
                     **{key: str(values[i]) for key, values in parts.items()}, 'cess': str(cesses[i])} for i, rate in enumerate(rates)]
    for key in FIELDS:
        if amounts[key] is not None and sum(Decimal(part[key]) for part in replacements) != amounts[key]:
            raise ValueError('Replacement rows must conserve every original monetary component.')
    return {'manual_required': False, 'method': method, 'tax_mode': mode, 'rows': replacements,
            'totals': {key: str(sum(Decimal(part[key]) for part in replacements)) for key in FIELDS},
            'rounding': 'Currency rounded to cents; tax reconciliation is limited to one cent per original component. Nonzero Cess requires explicit user allocations.'}

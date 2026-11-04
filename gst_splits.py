"""Decimal-only, conservative allocation of user-selected GST slabs."""
from decimal import Decimal, ROUND_HALF_UP, localcontext

CENT = Decimal('.01')
ALLOCATION_TOLERANCE = Decimal('5')
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
    # The review API supplies the complete per-slab allocation. Keep the
    # historical calculation branch below for internal callers while ensuring
    # the browser-facing path validates every entered component independently.
    if isinstance(taxable_allocations, list) and all(isinstance(part, dict) for part in taxable_allocations):
        return validate_split_allocations(row, rates, taxable_allocations)
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


def _currency(value):
    return format(value.quantize(CENT, rounding=ROUND_HALF_UP), 'f')


def _exact_decimal(value):
    return format(value, 'f')


def _signed_currency(value):
    prefix = '+' if value > 0 else '-' if value < 0 else ''
    return prefix + chr(0x20b9) + _exact_decimal(abs(value))


def validate_split_allocations(row, rates, allocations):
    """Validate complete user-entered slab allocations without changing amounts.

    Monetary inputs retain their entered Decimal precision. Per-component GST
    math and source-to-replacement totals may differ by at most five currency
    units. Nothing is adjusted.
    """
    with localcontext() as context:
        context.prec = 300
        return _validate_split_allocations(row, rates, allocations)


def _validate_split_allocations(row, rates, allocations):
    errors = []
    try:
        decimal_rates = [Decimal(str(value)) for value in rates]
    except (InvalidOperation, TypeError, ValueError):
        decimal_rates = []
    if not 2 <= len(decimal_rates) <= 10:
        errors.append('Select between two and ten GST slab rates.')
    elif len(set(decimal_rates)) != len(decimal_rates) or any(
            not value.is_finite() or value < 0 or value > 100 or value.as_tuple().exponent < -2
            for value in decimal_rates):
        errors.append('GST slab rates must be distinct values from 0 to 100 with at most two decimal places.')
    if len(allocations) != len(decimal_rates):
        errors.append('Enter one complete allocation for each saved GST slab rate.')

    original_names = {
        'invoice': ('Invoice Value', 'invoice_value'),
        'taxable': ('Taxable Value', 'taxable_value'),
        'igst': ('Integrated Tax', 'igst'),
        'cgst': ('Central Tax', 'cgst'),
        'sgst': ('State/UT Tax', 'sgst'),
        'cess': ('Cess', 'cess'),
    }
    original = {}
    for field, (label, source_key) in original_names.items():
        try:
            parsed = money(row.get(source_key))
            original[field] = parsed if parsed is not None else Decimal(0)
        except (InvalidOperation, TypeError, ValueError):
            original[field] = Decimal(0)
            errors.append(f'Original {label} is not a valid finite currency amount.')

    amount_fields = ('taxable', 'igst', 'cgst', 'sgst', 'cess')
    signs = {1 if amount > 0 else -1 for amount in original.values() if amount}
    if len(signs) > 1:
        errors.append('The original transaction contains mixed positive and negative amounts; it cannot be split safely.')
    original_sign = next(iter(signs), 0)

    normalized = []
    output_rows = []
    regime = None
    for index, allocation in enumerate(allocations):
        prefix = f'Slab {index + 1}'
        parsed = {}
        for field in amount_fields:
            label = original_names[field][0]
            try:
                value = money(allocation.get(field))
                if value is None:
                    raise ValueError
                parsed[field] = value
            except (InvalidOperation, TypeError, ValueError):
                parsed[field] = Decimal(0)
                errors.append(f'{prefix} {label} must be a finite currency amount.')
        for field, value in parsed.items():
            if original_sign == 0 and value:
                errors.append(f'{prefix} {original_names[field][0]} must be zero because the original transaction has no monetary sign.')
            elif original_sign and value and (1 if value > 0 else -1) != original_sign:
                errors.append(f'{prefix} {original_names[field][0]} must keep the original transaction sign.')

        rate = decimal_rates[index] if index < len(decimal_rates) else Decimal(0)
        igst, cgst, sgst = parsed['igst'], parsed['cgst'], parsed['sgst']
        has_igst = igst != 0
        has_intra_state = cgst != 0 or sgst != 0
        if has_igst and has_intra_state:
            errors.append(f'{prefix} cannot contain both Integrated Tax and Central/State tax.')
        current_regime = 'igst' if has_igst else 'cgst_sgst' if has_intra_state else None
        if current_regime and regime and current_regime != regime:
            errors.append('All replacement slabs must use the same tax regime as one transaction.')
        if current_regime:
            regime = current_regime
        if has_igst:
            if cgst != 0 or sgst != 0:
                errors.append(f'{prefix} Integrated Tax allocations require Central Tax and State/UT Tax to be zero.')
            tax_diffs = [('Integrated Tax', igst - parsed['taxable'] * rate / 100)]
        elif has_intra_state:
            if igst != 0:
                errors.append(f'{prefix} Central/State allocations require Integrated Tax to be zero.')
            half_tax = parsed['taxable'] * rate / 200
            tax_diffs = [('Central Tax', cgst - half_tax), ('State/UT Tax', sgst - half_tax)]
        else:
            expected_tax = parsed['taxable'] * rate / 100
            tax_diffs = [('GST', expected_tax)] if abs(expected_tax) > CENT else []
        for label, difference in tax_diffs:
            if abs(difference) > ALLOCATION_TOLERANCE:
                errors.append(f'{prefix} {label} does not match the selected rate {rate}%; difference from the exact rate calculation is {_signed_currency(difference)} (maximum tolerance ₹5).')

        invoice = sum((parsed[field] for field in amount_fields), Decimal(0))
        row_values = {'rate': format(rate.normalize(), 'f'), 'invoice': _exact_decimal(invoice),
                      **{field: _exact_decimal(parsed[field]) for field in amount_fields}}
        allocation_values = {field: _exact_decimal(parsed[field]) for field in amount_fields}
        normalized.append(allocation_values)
        output_rows.append(row_values)

    totals = {field: sum((Decimal(part[field]) for part in output_rows), Decimal(0))
              for field in ('invoice', *amount_fields)}
    differences = {field: totals[field] - original[field] for field in totals}
    labels = {field: original_names[field][0] for field in original_names}
    for field, difference in differences.items():
        if abs(difference) > ALLOCATION_TOLERANCE:
            errors.append(f'{labels[field]} total differs from the original by {_signed_currency(difference)} (maximum tolerance ₹5; replacement {_signed_currency(totals[field])}; original {_signed_currency(original[field])}).')

    return {
        'valid': not errors,
        'manual_required': bool(errors),
        'errors': errors,
        'allocations': normalized,
        'rows': output_rows,
        'totals': {field: _exact_decimal(value) for field, value in totals.items()},
        'original_totals': {field: _exact_decimal(value) for field, value in original.items()},
        'differences': {field: _exact_decimal(value) for field, value in differences.items()},
        'tax_regime': regime,
        'rounding': 'Entered decimal precision is preserved. Each slab tax calculation and each replacement total may differ from its source or selected-rate calculation by up to ₹5. Differences are shown and never adjusted.',
        'direction': 'credit' if original_sign < 0 else 'debit' if original_sign > 0 else 'zero',
    }


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
    # Invoice minus taxable value is not a reliable GST constraint: it may
    # include freight, discounts, or other non-GST charges. Only mapped source
    # tax components can determine automatic slab allocations.
    gst = igst + cgst + sgst if detected_mode else None
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
    # For manually entered slabs, invoice reconciliation is at whole currency
    # units. The cents can differ because slab-level GST is rounded separately.
    if inv is not None and sum(invoices).quantize(Decimal('1'), rounding=ROUND_HALF_UP) != inv.quantize(Decimal('1'), rounding=ROUND_HALF_UP):
        raise ValueError('invoice values do not sum; replacement invoice values must match the original invoice value to the nearest whole unit; check charges, Cess and allocations.')
    replacements = [{'rate': str(rate), 'taxable': str(taxable[i]), 'invoice': str(invoices[i]),
                     **{key: str(values[i]) for key, values in parts.items()}, 'cess': str(cesses[i])} for i, rate in enumerate(rates)]
    for key in FIELDS:
        if key != 'invoice' and amounts[key] is not None and sum(Decimal(part[key]) for part in replacements) != amounts[key]:
            raise ValueError('Replacement rows must conserve every original monetary component.')
    return {'manual_required': False, 'method': method, 'tax_mode': mode, 'rows': replacements,
            'totals': {key: str(sum(Decimal(part[key]) for part in replacements)) for key in FIELDS},
            'rounding': 'Currency rounded to cents; tax reconciliation is limited to one cent per original component. Nonzero Cess requires explicit user allocations.'}

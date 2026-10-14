from decimal import Decimal

import pytest

from gst_calculator import calculate_rate


@pytest.mark.parametrize(("invoice", "taxable", "rate"), [
    (105, 100, 5), (118, 100, 18),
    (105, "100.25", 5),  # sub-rupee rounding delta
    (105, 102, 5),        # between ₹1 and ₹50: assign and flag
])
def test_matches_and_rounding(invoice, taxable, rate):
    result = calculate_rate(invoice, taxable)
    assert result.rate == rate


def test_difference_at_least_fifty_is_unmatched():
    result = calculate_rate(300, 200)
    assert result.rate is None and result.flagged
    assert result.difference >= Decimal("50")


@pytest.mark.parametrize(("invoice", "taxable"), [(None, 2), ("bad", 2), (-3, 2), (105, float("nan"))])
def test_invalid_rows(invoice, taxable):
    result = calculate_rate(invoice, taxable)
    assert result.rate is None and result.flagged


@pytest.mark.parametrize(("invoice", "taxable", "reason"), [
    (None, 100, "Invoice Value is missing or invalid"),
    (105, None, "Taxable Value is missing or invalid"),
    (105, "not a number", "Taxable Value is missing or invalid"),
    (105, 0, "Taxable Value is zero or negative"),
    (0, 100, "Invoice Value is zero or negative"),
    (100, 105, "smaller than Taxable Value"),
])
def test_exceptional_invoices_are_blank_and_flagged(invoice, taxable, reason):
    result = calculate_rate(invoice, taxable)
    assert result.rate is None and result.flagged
    assert reason in result.message


def test_equally_close_is_ambiguous():
    # Midpoint between the two expected taxable values for invoice 118.
    result = calculate_rate(118, (Decimal(118) * 100 / 105 + 100) / 2)
    assert result.rate is None and "ambiguous" in result.message

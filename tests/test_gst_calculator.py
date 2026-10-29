from decimal import Decimal

import pytest

from gst_calculator import calculate_rate


@pytest.mark.parametrize(("invoice", "taxable", "rate"), [
    (100, 100, 0), (105, 100, 5), (112, 100, 12), (118, 100, 18), (128, 100, 28),
    (105, "100.25", 5),  # sub-rupee rounding delta
    (105, 102, 5),        # between ₹1 and ₹50: assign and flag
])
def test_matches_and_rounding(invoice, taxable, rate):
    result = calculate_rate(invoice, taxable)
    assert result.rate == rate


def test_difference_at_least_fifty_is_unmatched():
    result = calculate_rate(300, 100)
    assert result.rate is None and result.flagged
    assert result.difference >= Decimal("50")


def test_difference_below_one_is_matched_without_warning():
    result = calculate_rate(105, "100.25")
    assert result.rate == 5 and result.difference < Decimal("1")
    assert not result.flagged


def test_difference_below_fifty_is_assigned_and_flagged():
    result = calculate_rate(105, 102)
    assert result.rate == 5 and Decimal("1") <= result.difference < Decimal("50")
    assert result.flagged


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
    # Invoice 336 gives exact expected bases 320 (5%) and 300 (12%), midpoint 310.
    result = calculate_rate(336, 310)
    assert result.rate is None and "ambiguous" in result.message

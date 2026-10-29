"""Decimal based GST rate matching rules."""
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

SUPPORTED_RATES = (0, 5, 12, 18, 28)


@dataclass(frozen=True)
class RateResult:
    rate: int | None
    difference: Decimal | None
    flagged: bool
    message: str


def as_decimal(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        result = value
    else:
        try:
            result = Decimal(str(value).strip().replace(",", "").replace("₹", ""))
        except (InvalidOperation, ValueError, AttributeError):
            return None
    return result if result.is_finite() else None


def calculate_rate(invoice_value: Any, taxable_value: Any) -> RateResult:
    invoice, taxable = as_decimal(invoice_value), as_decimal(taxable_value)
    if invoice is None or taxable is None:
        missing = []
        if invoice is None:
            missing.append("Invoice Value is missing or invalid")
        if taxable is None:
            missing.append("Taxable Value is missing or invalid")
        return RateResult(None, None, True, "; ".join(missing))
    # Signed credits use the same magnitude-based matching and tolerances.
    # The original cells are never changed; mixed signs remain invalid.
    if invoice < 0 and taxable < 0:
        invoice, taxable = -invoice, -taxable
    if invoice <= 0 or taxable <= 0:
        invalid = []
        if invoice <= 0:
            invalid.append("Invoice Value is zero or negative")
        if taxable <= 0:
            invalid.append("Taxable Value is zero or negative")
        return RateResult(None, None, True, "; ".join(invalid))
    if invoice < taxable:
        return RateResult(None, abs(invoice - taxable), True,
                          "Invoice Value is smaller than Taxable Value; verify unexpected charges or multiple GST rates")
    candidates = [
        (abs(taxable - invoice * 100 / Decimal(100 + rate)), rate)
        for rate in SUPPORTED_RATES
    ]
    candidates.sort(key=lambda item: item[0])
    if candidates[0][0] == candidates[1][0]:
        nearest_rates = [rate for difference, rate in candidates if difference == candidates[0][0]]
        rates = " and ".join(f"{rate}%" for rate in nearest_rates)
        return RateResult(None, candidates[0][0], True, f"Equally close to {rates}; ambiguous")
    difference, rate = candidates[0]
    if difference >= Decimal(50):
        return RateResult(None, difference, True,
                          "Neither supported GST rate produces an acceptable match; possible multiple GST rates or additional charges")
    if difference >= Decimal(1):
        return RateResult(rate, difference, True,
                          "Difference is from ₹1 to less than ₹50; verify whether multiple GST rates or additional charges apply")
    return RateResult(rate, difference, False, "")

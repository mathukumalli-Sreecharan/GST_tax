# Read-only workbook handling

Uploaded `.xlsx` files are read from private temporary files and exported separately. Browser uploads do not expose Windows file attributes. The interface reports read-only status only when the workbook's `readOnlyRecommended` advisory setting is present. Direct Python path processing also checks the Windows read-only attribute when available. Uploaded bytes can be processed independently of a source file held open in Excel.

`process_workbook` accepts a source path or uploaded bytes. It reads a snapshot and uses OpenPyXL in normal editable mode. Source and output paths must differ, including filesystem aliases. Excel's advisory file-sharing element is retained because OpenPyXL does not model it.

Selected protected worksheets cannot be modified. An existing Rate(%) column may be kept through a byte-for-byte copy. Protected sheets elsewhere in the workbook and workbook structure protection are retained; column processing does not add, remove, or rename worksheets. Encrypted, rights-managed, password-to-modify, and unsupported packages are rejected. No passwords are removed or cracked. Existing formula/unsupported-feature preservation rejections remain in force.

Regression coverage is in `tests/test_read_only.py` and `tests/test_api.py`. It includes read-only paths, advisory settings, byte uploads independent of the source, protected sheets and workbook structure, security errors, source immutability, separate exports, all four GST rates, and formatting/protection retention. The encrypted-file regression exercises the compound-file signature used by encrypted Office workbooks; live Excel locking is not required to process bytes already uploaded.

# Browser workflow fixtures

`image-set.zip` is a normal ZIP created with PowerShell `Compress-Archive`, not with the
application's `fflate` dependency. It contains the existing Lena JPEG and reference PNG under a
shared `test-image-set/` root. The BMP is a 2x2 tiled rendering of the Lena image; its expanded
size and ordinary compression ratio make the browser exercise `fflate`'s asynchronous Worker
inflate path without resembling a ZIP bomb.

The two annotation JSON files target the normalized ZIP paths. The partial fixture has one valid
match, one dimension conflict, and one missing path. The rollback fixture changes the valid match
so the browser test can prove that an injected IndexedDB failure leaves both memory and storage
unchanged.

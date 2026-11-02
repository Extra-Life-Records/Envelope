"""The packaged exes tell Windows they are Envelope while keeping their SimpleMail file names."""
import re
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

import version_resource


def parse(text):
    """Evaluate the file the way PyInstaller does, with stand-ins that keep what they were given."""
    def node(kind):
        return lambda *args, **kwargs: {"kind": kind, "args": args, **kwargs}
    kinds = ("VSVersionInfo", "FixedFileInfo", "StringFileInfo", "StringTable", "StringStruct", "VarFileInfo", "VarStruct")
    return eval(text, {kind: node(kind) for kind in kinds})


class VersionResourceTest(unittest.TestCase):
    def test_both_exes_say_envelope_with_the_app_version(self):
        source = (REPO / "mailapp.py").read_text(encoding="utf-8")
        version = re.search(r'^APP_VERSION = "([\d.]+)"', source, re.M).group(1)
        with tempfile.TemporaryDirectory() as out:
            self.assertEqual(version_resource.main(out), 0)
            for key, description, filename in (("desktop", "Envelope", "SimpleMail.exe"),
                                               ("agent", "Envelope agent", "SimpleMailAgent.exe")):
                info = parse((Path(out) / f"version-{key}.txt").read_text(encoding="utf-8"))
                self.assertEqual(info["kind"], "VSVersionInfo")
                self.assertEqual(info["ffi"]["filevers"], tuple(int(n) for n in version.split(".")) + (0,))
                table = info["kids"][0]["args"][0][0]
                strings = dict(entry["args"] for entry in table["args"][1])
                self.assertEqual(strings["FileDescription"], description)
                self.assertEqual(strings["ProductName"], "Envelope")
                self.assertEqual(strings["OriginalFilename"], filename)
                self.assertEqual(strings["ProductVersion"], version)


if __name__ == "__main__":
    unittest.main()

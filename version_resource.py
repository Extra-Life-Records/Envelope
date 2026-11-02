"""Windows version details for the packaged exes, so Windows calls them Envelope (Task Manager, a new
taskbar pin, file properties) although the files keep the SimpleMail names older copies update from.

    python version_resource.py OUT_DIR   writes OUT_DIR/version-desktop.txt and OUT_DIR/version-agent.txt
                                         for PyInstaller's --version-file
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXES = {"desktop": ("Envelope", "SimpleMail.exe"), "agent": ("Envelope agent", "SimpleMailAgent.exe")}


def app_version():
    found = re.search(r'^APP_VERSION = "(\d+)\.(\d+)\.(\d+)"', (HERE / "mailapp.py").read_text(encoding="utf-8"), re.M)
    if not found:
        raise SystemExit("APP_VERSION not found in mailapp.py")
    return tuple(int(n) for n in found.groups())


def resource(description, filename, version):
    numbers = version + (0,)
    text = ".".join(str(n) for n in version)
    strings = {"CompanyName": "Extra Life Records", "FileDescription": description, "FileVersion": text,
               "InternalName": filename[:-len(".exe")], "OriginalFilename": filename,
               "ProductName": "Envelope", "ProductVersion": text}
    entries = ",\n        ".join(f"StringStruct({key!r}, {value!r})" for key, value in strings.items())
    return (f"VSVersionInfo(\n"
            f"  ffi=FixedFileInfo(filevers={numbers}, prodvers={numbers}, mask=0x3f, flags=0x0, OS=0x40004,\n"
            f"                    fileType=0x1, subtype=0x0, date=(0, 0)),\n"
            f"  kids=[\n"
            f"    StringFileInfo([StringTable('040904B0', [\n"
            f"        {entries}])]),\n"
            f"    VarFileInfo([VarStruct('Translation', [1033, 1200])])\n"
            f"  ]\n"
            f")\n")


def main(out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    version = app_version()
    for key, (description, filename) in EXES.items():
        (out / f"version-{key}.txt").write_text(resource(description, filename, version), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "build"))

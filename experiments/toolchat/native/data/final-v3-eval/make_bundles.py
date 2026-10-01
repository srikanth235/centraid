"""Copy stage-extra/bundles/{val,test} to bundles-v3/ with eval/sets/<set>.jsonl replaced by the v3 gold."""
import gzip, io, shutil, sys, tarfile
from pathlib import Path
HERE = Path(__file__).resolve().parent
SRC = Path("/home/user/stage-extra/bundles"); DST = Path("/home/user/stage-extra/bundles-v3")
for name in ("val", "test"):
    out = DST / name; out.mkdir(parents=True, exist_ok=True)
    for f in ("job.json", "kernel.py"):
        shutil.copy2(SRC / name / f, out / f)
    new = (HERE / f"{name}.jsonl").read_bytes()
    with tarfile.open(SRC / name / "bundle.dat", "r:gz") as tin, \
         gzip.GzipFile(out / "bundle.dat", "wb", compresslevel=9, mtime=0) as gz, tarfile.open(fileobj=gz, mode="w") as tout:
        for m in tin:
            if m.name == f"eval/sets/{name}.jsonl":
                m.size = len(new)
                tout.addfile(m, io.BytesIO(new))
            else:
                tout.addfile(m, tin.extractfile(m) if m.isfile() else None)
    print(name, "ok", (out / "bundle.dat").stat().st_size)

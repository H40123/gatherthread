"""Provider-free runtime fixture; production-path smoke requires UID 10001."""

import argparse
import os
from pathlib import Path
import subprocess
import sys


PROGRAM = """from decimal import Decimal, localcontext
from math import isqrt, prod
primes = [n for n in range(2, 1001) if all(n % d for d in range(2, isqrt(n) + 1))]
assert len(primes) == 168
product = prod(primes)
with localcontext() as context:
    context.prec = 220
    root = Decimal(product).sqrt()
    assert int(root) == isqrt(product)
print('PYTHON_STDLIB_OK')
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-uid", type=int, default=10001)
    options = parser.parse_args()
    assert os.getuid() == options.expected_uid
    assert os.environ.get("PYTHONDONTWRITEBYTECODE") == "1"
    assert os.environ.get("PIP_NO_INDEX") == "1"
    assert os.environ.get("PIP_DISABLE_PIP_VERSION_CHECK") == "1"
    exec(PROGRAM, {"__name__": "__main__"})
    subprocess.run([sys.executable, "-m", "venv", ".venv"], check=True, timeout=20,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    virtual_python = str(Path(".venv/bin/python").absolute())
    result = subprocess.run([virtual_python, "-c", PROGRAM], check=True, timeout=10,
                            capture_output=True, text=True)
    assert result.stdout == "PYTHON_STDLIB_OK\n"
    subprocess.run([virtual_python, "-m", "pip", "--version"], check=True, timeout=10,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # Collection must ignore both venv symlinks and disposable Python caches.
    Path("__pycache__").mkdir(exist_ok=True)
    Path("__pycache__/fixture-only.txt").write_text("not project source\n", encoding="utf8")
    print("PYTHON_VENV_PIP_OK")


if __name__ == "__main__":
    main()

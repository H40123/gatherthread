# Finder metadata build tools

The isolated build environment uses `ds_store` 1.3.3 and `mac_alias` 2.2.3,
both MIT, pinned to the official PyPI wheel hashes in `requirements-dmg.txt`:

- https://pypi.org/project/ds-store/1.3.3/
- https://files.pythonhosted.org/packages/66/c0/718a4132306ff8ff052f2c40595f45595993b480409400d55b07f3842d45/ds_store-1.3.3-py3-none-any.whl
- https://pypi.org/project/mac-alias/2.2.3/
- https://files.pythonhosted.org/packages/13/20/103f4e4a6e8a524ea92eee7d938c6133d0b129aa999a50f8648ad126c728/mac_alias-2.2.3-py3-none-any.whl

Their code is not copied into, or required by, the distributed Launcher.
They produce only `.DS_Store` metadata and a Finder image alias.

The Finder field names/semantics in `finder_window_settings`,
`finder_icon_settings` and `write_dmg_finder_layout` were checked against
`dmgbuild`, `src/dmgbuild/core.py`, immutable commit
`cc96fa235365b787ad0d73e4802a1f3953a62b19` (MIT):
https://github.com/dmgbuild/dmgbuild/blob/cc96fa235365b787ad0d73e4802a1f3953a62b19/src/dmgbuild/core.py

GatherThread supplies its own fixed two-icon layout, static approved background,
strict record/alias validation, private path removal, signature verification,
mount lifecycle and no-clobber publication. No upstream build orchestration or
Finder automation was copied.

## MIT notice

Copyright (c) 2014 Alastair Houghton
Copyright (c) 2017 The Qt Company Ltd.
Copyright (c) 2022 Russell Keith-Magee

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

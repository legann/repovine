import os
from os import getenv

PY_GETENV = os.getenv("PY_GETENV")
PY_GET = os.environ.get("PY_GET")
PY_SUBSCRIPT = os.environ["PY_SUBSCRIPT"]

env_alias = os.environ
PY_ALIAS = env_alias["PY_ALIAS_SECRET"]

PY_KEY = "PY_CONST_SECRET"
PY_CONST = os.getenv(PY_KEY)

PY_IMPORTED = getenv("PY_IMPORTED_SECRET")

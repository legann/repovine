import subprocess

import requests

from models import User


def load_user(name: str) -> User:
    return User(name)


def fetch_remote(url: str) -> bytes:
    return requests.get(url).content


def run_job(cmd: list) -> int:
    return subprocess.run(cmd).returncode

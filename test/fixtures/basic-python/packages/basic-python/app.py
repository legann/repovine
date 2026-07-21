import os

from .models import User
from .utils import greet
from sharedlib.helpers import format_label

API_VERSION = "1.0"


def handler(event, context):
    user = User(event["name"])
    return format_label(greet(user))


class App:
    def run(self):
        return handler({"name": os.environ.get("USER", "world")}, {})

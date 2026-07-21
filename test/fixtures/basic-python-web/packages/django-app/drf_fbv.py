from django.urls import path
from rest_framework.decorators import api_view


@api_view(["GET", "POST"])
def notes_list(request):
    return None


urlpatterns = [
    path("notes/", notes_list),
]

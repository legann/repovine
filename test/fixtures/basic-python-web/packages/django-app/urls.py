from django.urls import path, re_path


def list_users(request):
    return None


def item_detail(request, id):
    return None


urlpatterns = [
    path("users/", list_users),
    re_path(r"^items/(?P<id>\d+)/$", item_detail),
]

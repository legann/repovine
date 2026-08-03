from django.urls import include, path


def legacy_view(request):
    return None


legacy_patterns = [
    path("old-users/", legacy_view),
]

urlpatterns = [
    path("legacy/", include(legacy_patterns)),
]

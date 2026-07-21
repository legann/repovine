from django.urls import include, path


def core_view(request):
    return None


def extra_view(request):
    return None


core_patterns = [
    path("core/", core_view),
]

extra_patterns = [
    path("extra/", extra_view),
]

urlpatterns = core_patterns + [
    path("ns/", include((extra_patterns, "app"))),
]

more_patterns = [
    path("more/", extra_view),
]

urlpatterns += more_patterns

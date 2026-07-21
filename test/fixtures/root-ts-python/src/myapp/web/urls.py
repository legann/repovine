from django.urls import path

from myapp.api.health import health_view

urlpatterns = [
    path("api/health/", health_view),
]

from django.urls import include, path
from rest_framework.routers import DefaultRouter


class UserViewSet:
    pass


router = DefaultRouter()
router.register(r"users", UserViewSet)

urlpatterns = [
    path("api/", include(router.urls)),
]

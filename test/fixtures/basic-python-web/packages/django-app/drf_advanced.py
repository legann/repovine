from django.urls import include, path
from rest_framework.decorators import action
from rest_framework.routers import DefaultRouter, SimpleRouter


class InvoiceViewSet:
    @action(detail=False, methods=["get"], url_path="open")
    def open_invoices(self, request):
        return None

    @action(detail=True, methods=["post"], url_path="void")
    def void_invoice(self, request, pk=None):
        return None


class ReadOnlyViewSet:
    pass


class BillingRouter(DefaultRouter):
    pass


full_router = DefaultRouter()
full_router.register("invoices", InvoiceViewSet)

readonly_router = SimpleRouter()
readonly_router.register("reports", ReadOnlyViewSet)

billing_router = BillingRouter()
billing_router.register("billing", InvoiceViewSet)

urlpatterns = [
    path("v2/", include(full_router.urls)),
    path("ro/", include(readonly_router.urls)),
    path("c/", include(billing_router.urls)),
]

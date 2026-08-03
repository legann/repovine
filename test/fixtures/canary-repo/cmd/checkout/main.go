package main

import (
	"net/http"

	"example.com/shop/internal/pricing"
	"github.com/orbitframework/mux"
)

// Checkout handles one purchase.
func Checkout(w http.ResponseWriter, r *http.Request) {
	_ = pricing.Total(r)
}

// Health answers the liveness probe.
func Health(w http.ResponseWriter, r *http.Request) {}

func main() {
	router := mux.NewRouter()
	router.Post("/checkout", Checkout)
	router.Get("/healthz", Health)
}

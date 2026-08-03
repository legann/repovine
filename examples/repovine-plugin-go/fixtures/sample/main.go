package main

import (
	"github.com/gin-gonic/gin"
)

func main() {
	r := gin.Default()
	r.GET("/health", HealthCheck)
	r.GET("/orders/:id", GetOrder)
	r.POST("/orders", CreateOrder)
	_ = r.Run(":8080")
}

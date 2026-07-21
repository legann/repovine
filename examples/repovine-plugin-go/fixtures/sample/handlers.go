package main

import "github.com/gin-gonic/gin"

func HealthCheck(c *gin.Context) {
	c.JSON(200, gin.H{"status": "ok"})
}

func GetOrder(c *gin.Context) {
	c.JSON(200, gin.H{"id": c.Param("id")})
}

func CreateOrder(c *gin.Context) {
	c.JSON(201, gin.H{"created": true})
}

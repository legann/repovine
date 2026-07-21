# S3 bucket — kind='bucket'.
resource "aws_s3_bucket" "uploads" {
  bucket = "my-app-uploads"
}

# SecretsManager secret — kind='secret' (pattern A). Referenced cross-file by the Lambda in main.tf,
# so the uses_env edge is created by the deferred infra-link pass.
resource "aws_secretsmanager_secret" "db_password" {
  name = "app/db-password"
}

# SSM SecureString — kind='secret' ONLY because type=SecureString. Also referenced from main.tf.
resource "aws_ssm_parameter" "api_key" {
  name  = "/app/api-key"
  type  = "SecureString"
  value = "..."
}

# SSM plain String — stays kind='other' (negative case for the SecureString conditional).
resource "aws_ssm_parameter" "log_level" {
  name  = "/app/log-level"
  type  = "String"
  value = "info"
}

# GCP Secret Manager secret — kind='secret' (multi-cloud classification, no env ref).
resource "google_secret_manager_secret" "gcp_key" {
  secret_id = "gcp-api-key"
}

# Data source — extracted but kind='other' since it's not in the type map.
data "aws_caller_identity" "current" {}

# Module reference — kept as resource with terraformBlockType='module'.
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
  name   = "app-vpc"
  cidr   = "10.0.0.0/16"
}

# Output — skipped (not infrastructure).
output "bucket_name" {
  value = aws_s3_bucket.uploads.bucket
}

# Variable — skipped (not infrastructure).
variable "environment" {
  type    = string
  default = "dev"
}

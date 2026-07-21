# Top-level Terraform stack: Lambda + DynamoDB + SQS.
# Provider config (skipped from InfraResources because it's a provider block).
provider "aws" {
  region = "us-east-1"
}

# Lambda function — should become InfraResource kind='lambda' with handler/runtime attrs.
resource "aws_lambda_function" "users_api" {
  function_name = "users-api"
  filename      = "../dist/users.zip"
  handler       = "users.handler"
  runtime       = "nodejs22.x"
  role          = aws_iam_role.lambda_role.arn

  environment {
    variables = {
      USERS_TABLE   = aws_dynamodb_table.users.name
      DB_SECRET_ARN = aws_secretsmanager_secret.db_password.arn
      API_KEY_PARAM = aws_ssm_parameter.api_key.name
    }
  }
}

# IAM role — kind='role' via TERRAFORM_TYPE_TO_KIND.
resource "aws_iam_role" "lambda_role" {
  name = "users-api-lambda-role"
  assume_role_policy = "..."
}

# DynamoDB table — kind='table'.
resource "aws_dynamodb_table" "users" {
  name           = "Users"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key       = "userId"
}

# SQS queue — kind='queue'.
resource "aws_sqs_queue" "events" {
  name                       = "user-events"
  visibility_timeout_seconds = 30
}

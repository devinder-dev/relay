output "bucket_name" {
  description = "Bucket used by the backup Job."
  value       = aws_s3_bucket.backup.id
}

output "bucket_arn" {
  description = "The bucket's full AWS resource name, used in permission checks."
  value       = aws_s3_bucket.backup.arn
}

output "iam_user_name" {
  description = "Upload-only user whose access key is made separately."
  value       = aws_iam_user.backup.name
}

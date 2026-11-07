# Write the region out: a laptop's default region may be different.
provider "aws" {
  region = "eu-north-1"

  default_tags {
    tags = {
      project    = "relay"
      managed_by = "terraform"
    }
  }
}

locals {
  bucket_name = "myrelay-tech-db-backups"
  prefix      = "relay/"
}

# Dumps leave the server, so losing its disk does not lose every copy.
resource "aws_s3_bucket" "backup" {
  bucket = local.bucket_name
}

# Block public access, including a public policy or old access rules added by mistake.
resource "aws_s3_bucket_public_access_block" "backup" {
  bucket = aws_s3_bucket.backup.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# The bucket owner owns every upload. Separate object access rules cannot grant access.
resource "aws_s3_bucket_ownership_controls" "backup" {
  bucket = aws_s3_bucket.backup.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# An upload over an existing name keeps the old dump as an older version.
resource "aws_s3_bucket_versioning" "backup" {
  bucket = aws_s3_bucket.backup.id

  versioning_configuration {
    status = "Enabled"
  }
}

# S3 encrypts stored dumps with its own keys. This does not protect against a stolen admin login.
resource "aws_s3_bucket_server_side_encryption_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Keep storage bounded. A dump is the current version for 30 days; then expiration adds a
# delete marker and the dump is kept 30 more days as an older version (about 60 days in all).
# An overwritten dump likewise stays recoverable for about 30 days. Deletion is not immediate.
resource "aws_s3_bucket_lifecycle_configuration" "backup" {
  bucket     = aws_s3_bucket.backup.id
  depends_on = [aws_s3_bucket_versioning.backup]

  rule {
    id     = "relay-backup-retention"
    status = "Enabled"

    filter {
      prefix = local.prefix
    }

    expiration {
      days = 30
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# Refuse plain HTTP, so dump data and signed requests travel over encrypted HTTPS only.
data "aws_iam_policy_document" "tls_only" {
  statement {
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.backup.arn, "${aws_s3_bucket.backup.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

# Apply the HTTPS rule to both the bucket and the objects inside it.
resource "aws_s3_bucket_policy" "backup" {
  bucket = aws_s3_bucket.backup.id
  policy = data.aws_iam_policy_document.tls_only.json
}

# Give backups their own identity, separate from the admin who creates the bucket.
# Make its access key outside Terraform so the secret never enters the state file.
resource "aws_iam_user" "backup" {
  name = "relay-backup"
  path = "/relay/"
}

# A stolen key cannot read, list or delete dumps. It can upload junk (which costs money)
# or overwrite a name under relay/. The old version lasts 30 days after an overwrite:
# notice it within that window and recover by VersionId, the old version's identifier.
# One put-object request needs no multipart upload rights; dumps must fit within 5 GB.
data "aws_iam_policy_document" "upload_only" {
  statement {
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.backup.arn}/${local.prefix}*"]
  }
}

# Attach only the upload permission. Do not add read or delete permissions to this user.
resource "aws_iam_user_policy" "backup" {
  name   = "relay-backup-upload"
  user   = aws_iam_user.backup.name
  policy = data.aws_iam_policy_document.upload_only.json
}

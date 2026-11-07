# Backup bucket

Creates a private S3 bucket in `eu-north-1`, encrypted storage, HTTPS-only access,
retention and the upload-only `relay-backup` user. A dump is current for 30 days, then
kept 30 more days as an older version: about 60 days in all. An overwritten dump also
survives as an older version for about 30 days. Recover by VersionId within that window.

This is the project's only Terraform: the bucket and its IAM user are the only
resources that need it. Kubernetes uses YAML; the server and DNS have no suitable
provider ([context, IaC row](../../../docs/CONTEXT.md#stack-and-decisions)).

After review and merge, Devinder runs these commands from `main`, with an admin
user or role in the normal AWS credential chain, never the account's root user:

```sh
cd infra/terraform/backup
terraform init
terraform fmt -check
terraform validate
terraform plan
terraform apply
```

Terraform is pinned to `1.17.0` exactly (a release at least two weeks old), and the AWS
provider to `6.70.0`. A different Terraform refuses to run, on purpose. Install that exact
version from `releases.hashicorp.com` and check it against the release's `SHA256SUMS`.
`.terraform.lock.hcl` is committed: it records the provider's checksums for macOS (arm64,
amd64) and Linux amd64, so `init` gives the same provider on any of our machines.

The access key is made outside Terraform, so no secret is in the state. See
[runbook section 6](../../server/README.md#6-data-postgres-step-23-backups-in-phase-6).

## Who holds the state

State is local and gitignored: `infra/terraform/backup/terraform.tfstate` on Devinder's
laptop, the only machine with AWS admin access to this account. It holds resource
identities (names, ARNs), no secrets. It isn't copied anywhere: losing it costs minutes,
not data, because everything it describes can be read back from AWS.

If the state is lost (or someone else takes over with their own admin access), rebuild it
before any `apply`, from this folder. Never let `apply` try to create these again:

```sh
terraform init
terraform import aws_s3_bucket.backup myrelay-tech-db-backups
terraform import aws_s3_bucket_public_access_block.backup myrelay-tech-db-backups
terraform import aws_s3_bucket_ownership_controls.backup myrelay-tech-db-backups
terraform import aws_s3_bucket_versioning.backup myrelay-tech-db-backups
terraform import aws_s3_bucket_server_side_encryption_configuration.backup myrelay-tech-db-backups
terraform import aws_s3_bucket_lifecycle_configuration.backup myrelay-tech-db-backups
terraform import aws_s3_bucket_policy.backup myrelay-tech-db-backups
terraform import aws_iam_user.backup relay-backup
terraform import aws_iam_user_policy.backup relay-backup:relay-backup-upload
terraform plan   # must say: No changes
```

## What the lifecycle rule doesn't cover

It only applies under `relay/`, where the backup Job writes. Anything else in the bucket
never expires. Only an admin can write outside `relay/`, so delete any test object you put
there by hand, every version of it (`list-object-versions`, then `delete-object
--version-id`). Delete markers left by expiration are removed by S3 itself: with
`Expiration` in `days`, S3 cleans up expired object delete markers automatically
([AWS lifecycle examples](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-configuration-examples.html#lifecycle-config-conceptual-ex7)).

## Checks after apply

Run as the admin, from this folder. Every AWS command names Stockholm explicitly.
Expect versioning `Enabled`, all four public blocks `true`, encryption `AES256`,
the three retention settings, and a policy denying insecure transport.

```sh
aws s3api get-bucket-versioning --bucket myrelay-tech-db-backups --region eu-north-1
aws s3api get-public-access-block --bucket myrelay-tech-db-backups --region eu-north-1
aws s3api get-bucket-encryption --bucket myrelay-tech-db-backups --region eu-north-1
aws s3api get-bucket-lifecycle-configuration --bucket myrelay-tech-db-backups --region eu-north-1
aws s3api get-bucket-policy --bucket myrelay-tech-db-backups --region eu-north-1
```

This signed HTTP request must fail with `AccessDenied`. Keep admin credentials in
use: an anonymous 403 would only prove the bucket is private.

```sh
aws s3api list-objects-v2 --bucket myrelay-tech-db-backups --max-keys 1 --endpoint-url http://s3.eu-north-1.amazonaws.com --region eu-north-1
```

Simulate the user's permissions without writing or deleting data. Read its ARN
(full resource name) from AWS so no account id is stored here. The first command
must say `allowed`; every decision in the remaining commands must say
`implicitDeny`. This checks policy rights, not a real access-key connection.

```sh
user_arn=$(aws iam get-user --user-name relay-backup --query 'User.Arn' --output text --region eu-north-1)
aws iam simulate-principal-policy --policy-source-arn "$user_arn" --action-names s3:PutObject --resource-arns arn:aws:s3:::myrelay-tech-db-backups/relay/x --region eu-north-1
aws iam simulate-principal-policy --policy-source-arn "$user_arn" --action-names s3:GetObject s3:DeleteObject --resource-arns arn:aws:s3:::myrelay-tech-db-backups/relay/x --region eu-north-1
aws iam simulate-principal-policy --policy-source-arn "$user_arn" --action-names s3:ListBucket --resource-arns arn:aws:s3:::myrelay-tech-db-backups --region eu-north-1
aws iam simulate-principal-policy --policy-source-arn "$user_arn" --action-names s3:PutObject --resource-arns arn:aws:s3:::myrelay-tech-db-backups/outside/x --region eu-north-1
```

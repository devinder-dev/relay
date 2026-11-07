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

Terraform is pinned to `1.17.1`, and the AWS provider to `6.70.0`. After `init`,
commit `.terraform.lock.hcl` through review: it records the provider checksums.
It is deliberately not ignored.

State is local and gitignored. It records resource identities, holds no secrets in
this configuration, and must be kept safely. If lost, use `terraform import` for
the existing resources before the next `apply`; do not try to recreate them.
The access key is made outside Terraform. See [runbook section 6](../../server/README.md#6-data-postgres-step-23-backups-in-phase-6)
for the data runbook; backup key creation and rotation instructions are pending step 6-B.

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

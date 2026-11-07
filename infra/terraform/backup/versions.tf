# Exact versions keep both laptops on the same Terraform and provider code.
# Both are at least two weeks old when chosen (the team's rule for new releases):
# Terraform 1.17.0 came out on 21 Oct 2026, 1.17.1 only on 28 Oct.
terraform {
  required_version = "1.17.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.70.0"
    }
  }
}

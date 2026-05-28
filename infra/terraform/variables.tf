variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "ssh_public_key" {
  type        = string
  description = "Contents of your ~/.ssh/id_ed25519.pub (or id_rsa.pub)"
}

variable "ssh_cidr_blocks" {
  type        = list(string)
  description = "CIDR blocks allowed to SSH in. Default opens to the world — narrow this to your home IP for security (e.g. [\"1.2.3.4/32\"])."
  default     = ["0.0.0.0/0"]
}

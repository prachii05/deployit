output "public_ip" {
  value       = aws_eip.deployit.public_ip
  description = "Point your DNS A record (apex + wildcard) at this IP."
}

output "ssh" {
  value = "ssh ubuntu@${aws_eip.deployit.public_ip}"
}

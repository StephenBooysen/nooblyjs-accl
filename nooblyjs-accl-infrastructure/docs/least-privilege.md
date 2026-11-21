# Least-privilege access for a cloud account

Roadmap 2.10. Connecting a GCP project or an AWS account gives this accelerator the access below, and nothing more. The
lists come from the calls the adapters make (`src/providers/gcp/index.js`, `src/providers/aws/index.js`). They are
tested against fakes of the clouds' APIs, not yet against a real project or account: the sandbox run
(`INFRA_CLOUD_TESTS=gcp,aws`) is still open, so treat these lists as a starting point and tell us about any gap.

Everything the accelerator creates carries the label (GCP) or tag (AWS) `managed-by=noobly-cloud`, plus
`noobly-install=<install id>`. The AWS policy uses that tag to limit what may be changed.

## Google Cloud

You need two service accounts in the project:

| Service account | Holds | Used for |
| --- | --- | --- |
| `noobly-cloud@<project>.iam.gserviceaccount.com` | the custom role below, and **Service Account Token Creator** on `noobly-pull` only | everything; its key is what you paste |
| `noobly-pull@<project>.iam.gserviceaccount.com` | **Artifact Registry Reader** (`roles/artifactregistry.reader`) | the short-lived tokens hosts pull images with |

You can give the reader another name. If you do, add `"pullServiceAccount": "<email>"` to the key's JSON before you
paste it.

Create the custom role `nooblyCloud` with these permissions:

```text
compute.projects.get
compute.regions.list
compute.regions.get
compute.machineTypes.list
compute.images.useReadOnly
compute.disks.create
compute.networks.get
compute.networks.create
compute.networks.updatePolicy
compute.subnetworks.get
compute.subnetworks.create
compute.subnetworks.use
compute.subnetworks.useExternalIp
compute.instances.create
compute.instances.get
compute.instances.list
compute.instances.start
compute.instances.stop
compute.instances.reset
compute.instances.delete
compute.instances.setMetadata
compute.instances.setLabels
compute.instances.setTags
compute.addresses.create
compute.addresses.get
compute.addresses.list
compute.addresses.use
compute.addresses.delete
compute.addresses.setLabels
compute.firewalls.create
compute.firewalls.get
compute.firewalls.list
compute.firewalls.update
compute.firewalls.delete
compute.globalOperations.get
compute.regionOperations.get
compute.zoneOperations.get
monitoring.timeSeries.list
artifactregistry.repositories.create
artifactregistry.repositories.get
artifactregistry.repositories.uploadArtifacts
artifactregistry.repositories.downloadArtifacts
artifactregistry.repositories.deleteArtifacts
artifactregistry.dockerimages.list
artifactregistry.tags.get
artifactregistry.versions.delete
```

The project needs the Compute Engine, Cloud Monitoring, Artifact Registry and IAM Service Account Credentials APIs
turned on.

## AWS

Create two roles in the account. This server assumes `noobly-cloud` with its own AWS credentials, which you set in its
environment (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and, if they are temporary, `AWS_SESSION_TOKEN`). Then it
assumes `noobly-pull` from `noobly-cloud`. You paste the role ARN and the external ID, one per line. Access keys work
too, but a role is better: nothing long-lived is stored with the account.

### `noobly-cloud`

Trust policy. Use your server's principal, and an external ID that you make up and keep secret:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::<server account>:user/noobly-server" },
    "Action": "sts:AssumeRole",
    "Condition": { "StringEquals": { "sts:ExternalId": "<external id>" } }
  }]
}
```

Permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Read",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeRegions", "ec2:DescribeAvailabilityZones", "ec2:DescribeVpcs", "ec2:DescribeInternetGateways",
        "ec2:DescribeRouteTables", "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups", "ec2:DescribeImages",
        "ec2:DescribeInstanceTypeOfferings", "ec2:DescribeInstances", "ec2:DescribeAddresses",
        "cloudwatch:GetMetricStatistics", "ecr:GetAuthorizationToken", "ecr:DescribeRepositories"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CreateTagged",
      "Effect": "Allow",
      "Action": [
        "ec2:CreateVpc", "ec2:CreateInternetGateway", "ec2:CreateSubnet", "ec2:CreateSecurityGroup",
        "ec2:RunInstances", "ec2:AllocateAddress", "ec2:CreateTags"
      ],
      "Resource": "*",
      "Condition": { "StringEquals": { "aws:RequestTag/managed-by": "noobly-cloud" } }
    },
    {
      "Sid": "LaunchFrom",
      "Effect": "Allow",
      "Action": "ec2:RunInstances",
      "Resource": ["arn:aws:ec2:*::image/*", "arn:aws:ec2:*:*:subnet/*", "arn:aws:ec2:*:*:security-group/*", "arn:aws:ec2:*:*:network-interface/*"]
    },
    {
      "Sid": "ChangeOwn",
      "Effect": "Allow",
      "Action": [
        "ec2:ModifyVpcAttribute", "ec2:AttachInternetGateway", "ec2:CreateRoute",
        "ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress", "ec2:DeleteSecurityGroup",
        "ec2:StartInstances", "ec2:StopInstances", "ec2:RebootInstances", "ec2:TerminateInstances",
        "ec2:AssociateAddress", "ec2:DisassociateAddress", "ec2:ReleaseAddress"
      ],
      "Resource": "*",
      "Condition": { "StringEquals": { "aws:ResourceTag/managed-by": "noobly-cloud" } }
    },
    {
      "Sid": "Images",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:*::parameter/aws/service/*"
    },
    {
      "Sid": "Registry",
      "Effect": "Allow",
      "Action": [
        "ecr:CreateRepository", "ecr:TagResource", "ecr:DescribeImages", "ecr:BatchDeleteImage",
        "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"
      ],
      "Resource": "arn:aws:ecr:*:<account>:repository/noobly-*"
    },
    {
      "Sid": "Reader",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::<account>:role/noobly-pull"
    }
  ]
}
```

`CreateRoute` and `AttachInternetGateway` act on the route table and the VPC. The accelerator tags the VPC, but AWS
does not tag the main route table, so if the route cannot be added, add it once by hand: `0.0.0.0/0` to the internet
gateway.

### `noobly-pull`

Trust policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::<account>:role/noobly-cloud" },
    "Action": "sts:AssumeRole"
  }]
}
```

Permissions: `ecr:GetAuthorizationToken` on `*`, and `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` and
`ecr:BatchCheckLayerAvailability` on `arn:aws:ecr:*:<account>:repository/noobly-*`. To use another name, add
`"pullRoleArn"` to the credentials as JSON:
`{"roleArn": "...", "externalId": "...", "pullRoleArn": "..."}`.

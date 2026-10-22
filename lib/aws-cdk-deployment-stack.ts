
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';

export class MyCdkProjectStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. Read CDK context
    const instanceType = String(
      this.node.tryGetContext('instanceType') ?? 't3.micro'
    );
    const minCapacity = Number(this.node.tryGetContext('minCapacity') ?? 1);
    const desiredCapacity = Number(this.node.tryGetContext('desiredCapacity') ?? 2);
    const maxCapacity = Number(this.node.tryGetContext('maxCapacity') ?? 3);

    const dbEngine = String(this.node.tryGetContext('dbEngine') ?? 'mysql');
    const dbStorage = Number(this.node.tryGetContext('dbStorage') ?? 20);
    const dbMultiAz = String(this.node.tryGetContext('dbMultiAz') ?? false) === 'true';
    const dbInstanceType = String(
      this.node.tryGetContext('dbInstanceType') ?? 't3.micro'
    );

    if (!['mysql', 'postgres'].includes(dbEngine)) {
      throw new Error('dbEngine must be mysql or postgres');
    }
    if (minCapacity > desiredCapacity || desiredCapacity > maxCapacity) {
      throw new Error('Capacity must satisfy min <= desired <= max');
    }

    // 2. VPC: public, private and isolated subnets
    const vpc = new ec2.Vpc(this, 'CustomVPC', {
      ipAddresses: ec2.IpAddresses.cidr('10.20.0.0/16'),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: 'Database',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // Output private subnet IDs
    const privateSubnets = vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    });

    privateSubnets.subnets.forEach((subnet, index) => {
      new cdk.CfnOutput(this, `PrivateSubnet${index + 1}`, {
        value: subnet.subnetId,
      });
    });

    // 3. Security groups
    const albSG = new ec2.SecurityGroup(this, 'ALBSG', {
      vpc,
      description: 'ALB security group',
      allowAllOutbound: true,
    });

    albSG.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow public HTTP'
    );

    const ec2SG = new ec2.SecurityGroup(this, 'EC2SG', {
      vpc,
      description: 'EC2 application security group',
      allowAllOutbound: true,
    });

    ec2SG.addIngressRule(
      albSG,
      ec2.Port.tcp(80),
      'Allow HTTP from ALB'
    );

    const rdsSG = new ec2.SecurityGroup(this, 'RDSSG', {
      vpc,
      description: 'RDS database security group',
      allowAllOutbound: false,
    });

    const dbPort = dbEngine === 'postgres' ? 5432 : 3306;

    rdsSG.addIngressRule(
      ec2SG,
      ec2.Port.tcp(dbPort),
      'Allow database access from EC2'
    );

    // 4. IAM role and instance profile
    const role = new iam.Role(this, 'EC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });

    const instanceProfile = new iam.InstanceProfile(this, 'InstanceProfile', {
      role,
    });

    // 5. EC2 user data
    const userData = ec2.UserData.forLinux();

    userData.addCommands(
      'dnf install -y httpd',
      'systemctl enable httpd',
      'mkdir -p /var/www/html/health',
      'echo "Healthy" > /var/www/html/health/index.html',
      'echo "<h1>Hello from AWS CDK EC2!</h1>" > /var/www/html/index.html',
      'systemctl start httpd'
    );

    // 6. EC2 Launch Template
    const template = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      launchTemplateName: 'MyTemplateV1',
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      instanceType: new ec2.InstanceType(instanceType),
      securityGroup: ec2SG,
      instanceProfile,
      userData,
    });

    // 7. Auto Scaling Group
    const asg = new autoscaling.AutoScalingGroup(this, 'ASG', {
      vpc,
      launchTemplate: template,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      minCapacity,
      desiredCapacity,
      maxCapacity,
      groupMetrics: [autoscaling.GroupMetrics.all()],
    });

    asg.scaleOnCpuUtilization('CpuScalingPolicy', {
      targetUtilizationPercent: 50,
    });

    // 8. Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ApplicationALB', {
      vpc,
      internetFacing: true,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      securityGroup: albSG,
    });

    const listener = alb.addListener('HTTPListener', {
      port: 80,
      open: false,
    });

    listener.addTargets('EC2Targets', {
      port: 80,
      targets: [asg],
      healthCheck: {
        path: '/health',
        protocol: elbv2.Protocol.HTTP,
        healthyHttpCodes: '200',
      },
    });

    // 9. RDS database
    const engine = dbEngine === 'postgres'
      ? rds.DatabaseInstanceEngine.postgres({
          version: rds.PostgresEngineVersion.VER_16,
        })
      : rds.DatabaseInstanceEngine.mysql({
          version: rds.MysqlEngineVersion.VER_8_0,
        });

    const database = new rds.DatabaseInstance(this, 'ApplicationDatabase', {
      engine,
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [rdsSG],
      instanceType: new ec2.InstanceType(dbInstanceType),
      allocatedStorage: dbStorage,
      storageType: rds.StorageType.GP2,
      multiAz: dbMultiAz,
      credentials: rds.Credentials.fromGeneratedSecret('admin'),
      databaseName: 'applicationdb',
      publiclyAccessible: false,

      // Temporary lab settings only
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Permit EC2 to retrieve database credentials
    database.secret?.grantRead(role);

    // 10. CloudFormation outputs
    new cdk.CfnOutput(this, 'ALBDNSName', {
      value: alb.loadBalancerDnsName,
    });

    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: database.dbInstanceEndpointAddress,
    });

    if (database.secret) {
      new cdk.CfnOutput(this, 'DatabaseSecretArn', {
        value: database.secret.secretArn,
      });
    }
  }
}

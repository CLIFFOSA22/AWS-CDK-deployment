
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

    // Read configuration from cdk.json
    const requiredContext = (key: string): unknown => {
      const value = this.node.tryGetContext(key);
      if (value === undefined || value === null || value === '') {
        throw new Error(`Missing CDK context parameter: ${key}`);
      }
      return value;
    };

    const vpcCidr = String(requiredContext('vpcCidr'));
    const maxAzs = Number(requiredContext('maxAzs'));
    const natGateways = Number(requiredContext('natGateways'));

    const instanceType = String(requiredContext('instanceType'));
    const minCapacity = Number(requiredContext('minCapacity'));
    const desiredCapacity = Number(requiredContext('desiredCapacity'));
    const maxCapacity = Number(requiredContext('maxCapacity'));
    const cpuTarget = Number(requiredContext('cpuTarget'));

    const dbEngine = String(requiredContext('dbEngine'));
    const dbStorage = Number(requiredContext('dbStorage'));
    const dbInstanceType = String(requiredContext('dbInstanceType'));
    const dbMultiAz = String(requiredContext('dbMultiAz')) === 'true';

    const healthCheckPath = String(requiredContext('healthCheckPath'));

    // Validate configuration
    if (!['mysql', 'postgres'].includes(dbEngine)) {
      throw new Error('dbEngine must be mysql or postgres');
    }

    if (
      !Number.isInteger(minCapacity) ||
      !Number.isInteger(desiredCapacity) ||
      !Number.isInteger(maxCapacity) ||
      minCapacity < 0 ||
      minCapacity > desiredCapacity ||
      desiredCapacity > maxCapacity
    ) {
      throw new Error('Invalid ASG capacity configuration');
    }

    if (
      !Number.isInteger(maxAzs) ||
      maxAzs < 2 ||
      !Number.isInteger(natGateways) ||
      natGateways < 1 ||
      natGateways > maxAzs
    ) {
      throw new Error('Invalid Availability Zone or NAT Gateway settings');
    }

    if (!Number.isFinite(cpuTarget) || cpuTarget <= 0 || cpuTarget > 100) {
      throw new Error('cpuTarget must be between 1 and 100');
    }

    if (!Number.isInteger(dbStorage) || dbStorage < 20) {
      throw new Error('dbStorage must be at least 20 GB');
    }

    if (!healthCheckPath.startsWith('/')) {
      throw new Error('healthCheckPath must begin with /');
    }

    // VPC with public, private and isolated subnets
    const vpc = new ec2.Vpc(this, 'CustomVPC', {
      ipAddresses: ec2.IpAddresses.cidr(vpcCidr),
      maxAzs,
      natGateways,
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

    // ALB security group
    const albSG = new ec2.SecurityGroup(this, 'ALBSG', {
      vpc,
      description: 'Application Load Balancer security group',
      allowAllOutbound: true,
    });

    albSG.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP from internet'
    );

    // EC2 security group
    const ec2SG = new ec2.SecurityGroup(this, 'EC2SG', {
      vpc,
      description: 'EC2 application security group',
      allowAllOutbound: true,
    });

    ec2SG.addIngressRule(
      albSG,
      ec2.Port.tcp(80),
      'Allow HTTP from ALB only'
    );

    // RDS security group
    const rdsSG = new ec2.SecurityGroup(this, 'RDSSG', {
      vpc,
      description: 'RDS database security group',
      allowAllOutbound: false,
    });

    const dbPort = dbEngine === 'postgres' ? 5432 : 3306;

    rdsSG.addIngressRule(
      ec2SG,
      ec2.Port.tcp(dbPort),
      'Allow database traffic from EC2 only'
    );

    // IAM role and instance profile
    const role = new iam.Role(this, 'EC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });

    const instanceProfile = new iam.InstanceProfile(this, 'InstanceProfile', {
      role,
    });

    // EC2 user data
    const userData = ec2.UserData.forLinux();

    userData.addCommands(
      'dnf install -y httpd',
      'systemctl enable httpd',
      'mkdir -p /var/www/html/health',
      'echo "Healthy" > /var/www/html/health/index.html',
      'echo "<h1>Hello from AWS CDK EC2!</h1>" > /var/www/html/index.html',
      'systemctl start httpd'
    );

    // EC2 Launch Template
    const template = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      instanceType: new ec2.InstanceType(instanceType),
      securityGroup: ec2SG,
      instanceProfile,
      userData,
    });

    // Auto Scaling Group
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

    // CPU target tracking scaling policy
    asg.scaleOnCpuUtilization('CpuScalingPolicy', {
      targetUtilizationPercent: cpuTarget,
    });

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ApplicationALB', {
      vpc,
      internetFacing: true,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      securityGroup: albSG,
    });

    // HTTP listener
    const listener = alb.addListener('HTTPListener', {
      port: 80,
      open: false,
    });

    // Target group and health checks
    listener.addTargets('EC2Targets', {
      port: 80,
      targets: [asg],
      healthCheck: {
        path: healthCheckPath,
        protocol: elbv2.Protocol.HTTP,
        healthyHttpCodes: '200',
      },
    });

    // RDS database engine
    const engine = dbEngine === 'postgres'
      ? rds.DatabaseInstanceEngine.postgres({
          version: rds.PostgresEngineVersion.VER_16,
        })
      : rds.DatabaseInstanceEngine.mysql({
          version: rds.MysqlEngineVersion.VER_8_0,
        });


//  RDS database
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
  storageEncrypted: true,
  multiAz: dbMultiAz,
  credentials: rds.Credentials.fromGeneratedSecret('dbmaster'),
  databaseName: 'applicationdb',
  publiclyAccessible: false,

  // Lab environment only
  deletionProtection: false,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});

    // Allow EC2 role to retrieve database credentials
    database.secret?.grantRead(role);

    // CloudFormation outputs
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

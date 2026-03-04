import { RDSClient, StartDBClusterCommand, StopDBClusterCommand } from '@aws-sdk/client-rds';

const rds = new RDSClient({});
const clusterIdentifier = process.env.DEGREE_WORKS_CLUSTER_ID!;

export const handler = async (event: { action: string }) => {
  const { action } = event;

  if (action === 'start') {
    await rds.send(new StartDBClusterCommand({ DBClusterIdentifier: clusterIdentifier }));
    console.log(`Started cluster ${clusterIdentifier}`);
  } else if (action === 'stop') {
    await rds.send(new StopDBClusterCommand({ DBClusterIdentifier: clusterIdentifier }));
    console.log(`Stopped cluster ${clusterIdentifier}`);
  } else {
    throw new Error(`Unknown action: ${action}`);
  }
};

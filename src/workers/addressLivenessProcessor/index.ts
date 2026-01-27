import { SQSEvent, SQSHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { AddressLivenessMessage } from '../../lib/types/inquiry';
import { verifyAddress } from '../../lib/melissa/personatorClient';

const dynamoClient = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(dynamoClient);

const applicationsTableName = process.env.APPLICATIONS_TABLE;
const inquiriesTableName = process.env.INQUIRIES_TABLE;

export const handler: SQSHandler = async (event: SQSEvent): Promise<void> => {
  console.info('Received SQS event:', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    const message = AddressLivenessMessage.parse(JSON.parse(record.body));
    const { inquiryId, studentId } = message;

    console.info(`Processing inquiry ${inquiryId} for student ${studentId}`);

    try {
      // 1. Update inquiry status to IN_PROGRESS
      await updateInquiryStatus(inquiryId, 'IN_PROGRESS');

      // 2. Fetch the inquiry to get input address
      const inquiryResult = await ddbDocClient.send(
        new GetCommand({
          TableName: inquiriesTableName,
          Key: { inquiryId },
        }),
      );

      if (!inquiryResult.Item) {
        throw new Error(`Inquiry ${inquiryId} not found`);
      }

      console.info('Inquiry input address:', JSON.stringify(inquiryResult.Item.inputAddress, null, 2));

      // 3. Fetch FAFSA application to get full details
      const applicationResult = await ddbDocClient.send(
        new QueryCommand({
          TableName: applicationsTableName,
          IndexName: 'studentId-index',
          KeyConditionExpression: 'studentId = :studentId',
          ExpressionAttributeValues: {
            ':studentId': studentId,
          },
          Limit: 1,
        }),
      );

      if (!applicationResult.Items || applicationResult.Items.length === 0) {
        throw new Error(`No FAFSA application found for student ${studentId}`);
      }

      const application = applicationResult.Items[0];

      // 4. Call Melissa Personator API
      const verificationInput = {
        firstName: application.first_name as string,
        lastName: application.last_name as string,
        streetAddress: application.street_address as string,
        city: application.city as string,
        state: application.mailing_state as string,
        zipCode: application.zip_code as string,
        dateOfBirth: application.date_of_birth as string,
      };

      console.info('Calling Melissa API with input:', JSON.stringify(verificationInput, null, 2));

      const verificationOutput = await verifyAddress(verificationInput);

      console.info('Melissa API response:', JSON.stringify(verificationOutput.result, null, 2));

      // 5. Update inquiry with results
      const now = new Date().toISOString();

      await ddbDocClient.send(
        new UpdateCommand({
          TableName: inquiriesTableName,
          Key: { inquiryId },
          UpdateExpression:
            'SET #status = :status, updatedAt = :updatedAt, melissaResponse = :melissaResponse, #result = :result',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#result': 'result',
          },
          ExpressionAttributeValues: {
            ':status': 'COMPLETED',
            ':updatedAt': now,
            ':melissaResponse': verificationOutput.rawResponse,
            ':result': verificationOutput.result,
          },
        }),
      );

      console.info(`Successfully completed inquiry ${inquiryId}`);
    } catch (error) {
      console.error(`Error processing inquiry ${inquiryId}:`, error);

      // Update inquiry with error status
      const now = new Date().toISOString();
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred';

      try {
        await ddbDocClient.send(
          new UpdateCommand({
            TableName: inquiriesTableName,
            Key: { inquiryId },
            UpdateExpression:
              'SET #status = :status, updatedAt = :updatedAt, errorMessage = :errorMessage',
            ExpressionAttributeNames: {
              '#status': 'status',
            },
            ExpressionAttributeValues: {
              ':status': 'FAILED',
              ':updatedAt': now,
              ':errorMessage': errorMessage,
            },
          }),
        );
      } catch (updateError) {
        console.error(
          `Failed to update inquiry ${inquiryId} with error status:`,
          updateError,
        );
      }

      // Re-throw to let SQS handle the retry
      throw error;
    }
  }
};

async function updateInquiryStatus(
  inquiryId: string,
  status: string,
): Promise<void> {
  const now = new Date().toISOString();

  await ddbDocClient.send(
    new UpdateCommand({
      TableName: inquiriesTableName,
      Key: { inquiryId },
      UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':status': status,
        ':updatedAt': now,
      },
    }),
  );
}

#!/usr/bin/env bash
set -euo pipefail

# -------------------------------------------------------------------
# setup-test-users.sh
#
# Creates Cognito test users for the advising meeting booking flow.
# Uses admin-create-user with --message-action SUPPRESS to bypass
# email verification entirely.
#
# Usage:
#   ./scripts/setup-test-users.sh <USER_POOL_ID> <CLIENT_ID>
#
# Or via environment variables:
#   USER_POOL_ID=us-east-1_xxx CLIENT_ID=yyy ./scripts/setup-test-users.sh
# -------------------------------------------------------------------

USER_POOL_ID="${1:-${USER_POOL_ID:-}}"
CLIENT_ID="${2:-${CLIENT_ID:-}}"
PASSWORD="TestPass123!"

if [[ -z "$USER_POOL_ID" || -z "$CLIENT_ID" ]]; then
  echo "Usage: $0 <USER_POOL_ID> <CLIENT_ID>"
  echo "  or set USER_POOL_ID and CLIENT_ID environment variables"
  exit 1
fi

echo "User Pool ID: $USER_POOL_ID"
echo "Client ID:    $CLIENT_ID"
echo ""

# -------------------------------------------------------------------
# Ensure custom:studentId attribute exists on the User Pool
# -------------------------------------------------------------------
ensure_custom_attribute() {
  local existing
  existing=$(aws cognito-idp describe-user-pool \
    --user-pool-id "$USER_POOL_ID" \
    --query "UserPool.SchemaAttributes[?Name=='custom:studentId'].Name" \
    --output text 2>/dev/null || true)

  if [[ -z "$existing" ]]; then
    echo "Adding custom:studentId attribute to the User Pool..."
    aws cognito-idp add-custom-attributes \
      --user-pool-id "$USER_POOL_ID" \
      --custom-attributes Name=studentId,AttributeDataType=Number,Mutable=true
    echo "  -> custom:studentId attribute added."
  else
    echo "custom:studentId attribute already exists."
  fi
}

# -------------------------------------------------------------------
# Ensure a Cognito group exists
# -------------------------------------------------------------------
ensure_group() {
  local group_name="$1"
  if aws cognito-idp get-group \
    --user-pool-id "$USER_POOL_ID" \
    --group-name "$group_name" &>/dev/null; then
    echo "Group '$group_name' already exists."
  else
    echo "Creating group '$group_name'..."
    aws cognito-idp create-group \
      --user-pool-id "$USER_POOL_ID" \
      --group-name "$group_name"
    echo "  -> Group '$group_name' created."
  fi
}

# -------------------------------------------------------------------
# Create a user (idempotent), set password, add to group
# -------------------------------------------------------------------
create_user() {
  local username="$1"
  local email="$2"
  local group="$3"
  shift 3
  local extra_attrs=()
  if [[ $# -gt 0 ]]; then
    extra_attrs=("$@")
  fi

  # Check if user already exists
  if aws cognito-idp admin-get-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$username" &>/dev/null; then
    echo "User '$username' already exists — skipping creation."
  else
    local attrs=(
      "Name=email,Value=$email"
      "Name=email_verified,Value=true"
    )
    if [[ ${#extra_attrs[@]} -gt 0 ]]; then
      for attr in "${extra_attrs[@]}"; do
        attrs+=("$attr")
      done
    fi

    echo "Creating user '$username'..."
    aws cognito-idp admin-create-user \
      --user-pool-id "$USER_POOL_ID" \
      --username "$username" \
      --user-attributes "${attrs[@]}" \
      --message-action SUPPRESS \
      --output text >/dev/null
    echo "  -> User '$username' created."
  fi

  # Set permanent password
  aws cognito-idp admin-set-user-password \
    --user-pool-id "$USER_POOL_ID" \
    --username "$username" \
    --password "$PASSWORD" \
    --permanent
  echo "  -> Password set for '$username'."

  # Add to group
  aws cognito-idp admin-add-user-to-group \
    --user-pool-id "$USER_POOL_ID" \
    --username "$username" \
    --group-name "$group"
  echo "  -> Added '$username' to group '$group'."
}

# -------------------------------------------------------------------
# Main
# -------------------------------------------------------------------
echo "=== Ensuring custom attributes ==="
ensure_custom_attribute
echo ""

echo "=== Ensuring groups ==="
ensure_group "advising-advisor"
ensure_group "advising-admin"
ensure_group "advising-student"
echo ""

echo "=== Creating users ==="
echo ""

echo "--- Advisor ---"
create_user "advisor1" "advisor1@test.local" "advising-advisor"
echo ""

echo "--- Admin ---"
create_user "admin1" "admin1@test.local" "advising-admin"
echo ""

echo "--- Students ---"
create_user "student1" "student1@test.local" "advising-student" \
  "Name=custom:studentId,Value=1"
echo ""

create_user "student2" "student2@test.local" "advising-student" \
  "Name=custom:studentId,Value=2"
echo ""

create_user "student3" "student3@test.local" "advising-student" \
  "Name=custom:studentId,Value=3"
echo ""

# -------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------
echo "==========================================="
echo "  Test Users Summary"
echo "==========================================="
echo ""
printf "%-12s %-25s %-20s %-20s\n" "Username" "Email" "Group" "Extra"
printf "%-12s %-25s %-20s %-20s\n" "--------" "-----" "-----" "-----"
printf "%-12s %-25s %-20s %-20s\n" "advisor1" "advisor1@test.local" "advising-advisor" ""
printf "%-12s %-25s %-20s %-20s\n" "admin1" "admin1@test.local" "advising-admin" ""
printf "%-12s %-25s %-20s %-20s\n" "student1" "student1@test.local" "advising-student" "studentId=1"
printf "%-12s %-25s %-20s %-20s\n" "student2" "student2@test.local" "advising-student" "studentId=2"
printf "%-12s %-25s %-20s %-20s\n" "student3" "student3@test.local" "advising-student" "studentId=3"
echo ""
echo "Password for all users: $PASSWORD"
echo ""
echo "To authenticate, run:"
echo "  aws cognito-idp admin-initiate-auth \\"
echo "    --user-pool-id $USER_POOL_ID \\"
echo "    --client-id $CLIENT_ID \\"
echo "    --auth-flow ADMIN_NO_SRP_AUTH \\"
echo "    --auth-parameters USERNAME=<username>,PASSWORD=$PASSWORD"
echo ""
echo "Done."

# Simple Financial Status Tracker

print("=" * 40)
print("      SIMPLE EXPENSE TRACKER")
print("=" * 40)

# Get initial balance
while True:
    try:
        initial_balance = float(input("\nEnter your initial balance: $"))
        if initial_balance < 0:
            print("Balance cannot be negative.")
            continue
        break
    except ValueError:
        print("Please enter a valid number.")

balance = initial_balance
total_expenses = 0

print("\nEnter your expenses one by one.")
print("Type 'done' when you are finished.\n")

# Enter expenses
while True:
    expense = input("Enter expense: $")

    if expense.lower() == "done":
        break

    try:
        expense = float(expense)

        if expense <= 0:
            print("Expense must be greater than 0.")
            continue

        if expense > balance:
            print("⚠️ Warning: This expense is greater than your remaining balance.")

        balance -= expense
        total_expenses += expense

        print(f"Remaining balance: ${balance:.2f}\n")

    except ValueError:
        print("Please enter a valid number or 'done'.")

# Financial status
percentage_spent = (total_expenses / initial_balance * 100) if initial_balance > 0 else 100

if balance < 0:
    status = "🔴 CRITICAL - You are spending more than your available balance."
elif percentage_spent >= 80:
    status = "🔴 WARNING - You have spent most of your money."
elif percentage_spent >= 50:
    status = "🟡 CAUTION - You have spent more than half of your money."
else:
    status = "🟢 HEALTHY - Your spending is currently under control."

# Display summary
print("\n" + "=" * 40)
print("          FINANCIAL STATUS")
print("=" * 40)

print(f"Initial Balance : ${initial_balance:,.2f}")
print(f"Total Expenses  : ${total_expenses:,.2f}")
print(f"Remaining       : ${balance:,.2f}")
print(f"Spent           : {percentage_spent:.1f}%")

print("\n" + status)
print("=" * 40)
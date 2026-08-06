# Simple Financial Health Calculator

print("================================")
print("   FINANCIAL CALCUTOR")
print("================================")

# Get the initial balance
balance = float(input("Enter your initial balance: "))

# Get expenses
expense1 = float(input("Enter expense 100: "))
expense2 = float(input("Enter expense 277: "))
expense3 = float(input("Enter expense 300: "))

# Calculate total expenses
total_expenses = expense1 + expense2 + expense3

# Calculate remaining balance
remaining = balance - total_expenses

# Calculate percentage spent
percentage_spent = (total_expenses / balance) * 100

# Display results
print("\n========== RESULTS ==========")


print("Total Expenses:  $", total_expenses)
print("Remaining:       $", remaining)
print("Percentage Spent:", round(percentage_spent, 1), "%")

# Determine financial health
if percentage_spent < 50:
    print("Status: HEALTHY")

elif percentage_spent < 80:
    print("Status: CAUTION")

else:
    print("Status: WARNING")

print("=============================")

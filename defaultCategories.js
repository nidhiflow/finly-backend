// Shared canonical default categories for all users
// Used by seedDefaultsForUser (new users) and /api/categories/sync-defaults (existing users)

// Expense defaults (ONLY the new list you provided)
export const defaultExpenseCategories = [
  {
    name: 'Food',
    icon: '🍔',
    color: '#FF6B6B',
    subs: [
      'Breakfast',
      'Lunch',
      'Dinner',
      'Hot Beverage',
      'Cold Beverages',
      'Alcoholic Beverages',
      'Junk Snacks',
      'Healthy Snacks',
      'Online Orders',
    ],
  },
  { name: 'Entertainment', icon: '🎬', color: '#96CEB4', subs: ['Theater', 'Stage Shows', 'Passive Games', 'OTT Subscriptions', 'DTH'] },
  {
    name: 'Household',
    icon: '🏡',
    color: '#F7DC6F',
    subs: [
      'Appliances',
      'Furnitures',
      'Kitchen Items',
      'Decoratives',
      'Repair and Maintenance',
      'Utility Items',
      'Rent',
    ],
  },
  { name: 'Health', icon: '🏥', color: '#DDA0DD', subs: ['Gym', 'Active Games', 'Supplements', 'Medicines', 'Doctor Consultation', 'Labs and Tests'] },
  { name: 'Investments', icon: '📈', color: '#1ABC9C', subs: ['Real Estate', 'Physical Gold', 'ETF', 'Stocks', 'Mutual Funds', 'Bonds', 'Digital Gold', 'Life Insurance', 'Health Insurance', 'Knowledge'] },
  { name: 'Personal Care', icon: '💅', color: '#E056A0', subs: ['Clothing', 'Clothing Accessories', 'Cosmetics', 'Parlour', 'Beauty Accessories'] },
  { name: 'Home Provisions', icon: '🛒', color: '#27AE60', subs: ['Online Grocery', 'Shop Grocery', 'Online Veggies', 'Shop Veggies', 'Online Fruits', 'Shop Fruits', 'Dairy', 'Meat'] },
  { name: 'Recharges', icon: '📱', color: '#3498DB', subs: ['Mobile Recharges', 'Wifi Bill'] },
  { name: 'Debts', icon: '🏦', color: '#E74C3C', subs: ['Housing EMI', 'Credit Card EMI', 'Gold EMI', 'Friends', 'Family', 'Personal EMI'] },
  { name: 'Gifts', icon: '🎁', color: '#F39C12', subs: ['Family', 'Friends', 'Public'] },
  { name: 'Travel', icon: '✈️', color: '#BB8FCE', subs: ['Train', 'Bus', 'Car', 'Flight', 'Taxi', 'Toll'] },
  { name: 'Vehicle', icon: '🚗', color: '#4ECDC4', subs: ['Car Fuel', 'Bike Fuel', 'Car Maintenance', 'Bike Maintenance', 'Others'] },
  { name: 'Vacation and Outing', icon: '🏖️', color: '#45B7D1', subs: ['Train', 'Bus', 'Car', 'Toll', 'Flight', 'Taxi', 'Entrance Fee', 'Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Alcoholic Beverages'] },
  { name: 'Government', icon: '🏛️', color: '#7F8C8D', subs: ['ITR', 'Property Tax', 'Government Fees'] },
  { name: 'Home Utilities', icon: '💡', color: '#FFEAA7', subs: ['EB', 'Gas'] },
];

// Income defaults (ONLY the new list you provided)
export const defaultIncomeCategories = [
  { name: 'Salary', icon: '💰', color: '#2ECC71', subs: [] },
  { name: 'Business', icon: '💼', color: '#F39C12', subs: [] },
  { name: 'Freelancing', icon: '💻', color: '#27AE60', subs: [] },
  { name: 'Debt and Loan', icon: '🏦', color: '#E74C3C', subs: [] },
  { name: 'Gifts and Rewards', icon: '🎁', color: '#9B59B6', subs: [] },
];


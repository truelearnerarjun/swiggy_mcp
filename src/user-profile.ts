/**
 * User nutrition profile.
 *
 * Edit this object to match your actual dietary goals.
 * The agent instructions are built dynamically from this config.
 */
export const userProfile = {
  /** Primary fitness goal */
  goal: "muscle gain",

  /** Dietary preference */
  diet: "vegetarian",

  /** Target grams of protein per day */
  dailyProteinGrams: 120,

  /** Target calories per day */
  dailyCalories: 2200,

  /** Maximum spend per meal in Indian Rupees */
  budgetPerMeal: 250,

  /** Foods / cuisines to explicitly avoid */
  avoid: ["very spicy food"],

  /** Meal timing preferences (for future autopilot mode) */
  mealTimes: {
    lunch: "12:30",
    dinner: "20:00",
  },
} as const;

export type UserProfile = typeof userProfile;

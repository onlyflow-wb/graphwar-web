// Graphwar web port. Original © 2011 Lucas Catabriga Rocha, GPL-3.0-or-later.
// Values are copied from GraphServer/Constants.java.

export const WIDTH = 800;
export const HEIGHT = 600;

export const START_GAME_DELAY = 5000;
export const TURN_TIME = 60000;

export const MAX_PLAYERS = 10;
export const MAX_SOLDIERS_PER_PLAYER = 4;
export const MAX_CLIENTS = 10;
export const INITIAL_NUM_SOLDIERS = 2;

export const MAXIMUM_COLOR_MODULE_SQUARED = 3 * 160 * 160;

export const TEAM1 = 1;
export const TEAM2 = 2;

export const NORMAL_FUNC = 0;
export const FST_ODE = 1;
export const SND_ODE = 2;
export type GameMode = 0 | 1 | 2;

export const PLANE_LENGTH = 770;
export const PLANE_HEIGHT = 450;
export const PLANE_GAME_LENGTH = 50;

export const CIRCLE_MEAN_RADIUS = 40;
export const CIRCLE_STANDARD_DEVIATION = 25;
export const NUM_CIRCLES_MEAN_VALUE = 15;
export const NUM_CIRCLES_STANDARD_DEVIATION = 7;

export const SOLDIER_RADIUS = 7;
export const SOLDIER_SELECTION_RADIUS = 15;
export const SOLDIER_ANIMATION_DELAY_STANDARD_DEVIATION = 5000;
export const SOLDIER_ANIMATION_MEAN_VALUE = 3000;
export const SOLDIER_MAX_DEATH_TIME = 6000;
export const NAME_FADE_TIME = 1000;

export const EXPLOSION_RADIUS = 12;

export const FUNCTION_VELOCITY = 1500; // steps per second
export const FUNC_FADE_TIME = 1000;
export const NEXT_TURN_DELAY = 3000;

export const FUNC_MAX_STEPS = 20000;
export const FUNC_MAX_STEP_DISTANCE_SQUARED = 0.001;
export const FUNC_MIN_X_STEP_DISTANCE = 0.00001;
export const STEP_SIZE = 0.01;
export const ANGLE_ERROR = Math.PI / 360;
export const MAX_ANGLE_LOOPS = 100;

export const ANGLE_ACCELERATION = 0.000003;

// AI
export const NUM_FUNCTIONS_AI = 50;
export const NUM_FUNCTIONS_UNCHANGED_TURN_AI = 5;
export const NUM_FUNCTION_MUTATED_AI = 25;
export const RANDOM_FUNC_MEAN_LENGTH = 10;
export const RANDOM_FUNC_VALUE_CHANCE = 0.5;
export const RANDOM_FUNC_VARIABLE_CHANCE = 0.5;
export const RANDOM_FUNC_VALUE_MEAN = 10.2;
export const RANDOM_FUNC_MEAN_CROSSOVER_LENGTH = 5;
export const MAX_AI_TIME = 2;

export const COMPUTER_NAMES = [
  'Deep Thought', 'HAL', 'Skynet', 'Agent Smith', 'Multivac',
  'Deep Blue', 'Cleverbot', 'Alpha Zordon', 'Wolfram',
];
export const COMPUTER_LEVEL_STANDARD_DEVIATION = 40;
export const COMPUTER_LEVEL_MEAN_VALUE = 50;
export const COMPUTER_LEVEL_MIN_VALUE = 10;

export const enum GameState { NONE = 0, PRE_GAME = 1, GAME = 2 }

# Summary of src Directory Contents

1. **ai.ts**: Contains the core AI logic for generating text responses using a predefined model and tools. It includes a function `generateTextAI` that processes messages and generates responses.
2. **core.ts**: Defines the main execution logic for the Coder Demo. It initializes the system and processes user prompts through a loop.
3. **index.ts**: The entry point of the application, which simply calls the `run` function from `core.ts`.
4. **loop.ts**: Implements a loop mechanism to handle iterative interactions with the AI, processing messages and managing tool results until a condition is met.
5. **config**: Configuration files for the AI model and settings.
6. **prompt**: Contains prompt generation logic.
7. **tools**: Defines built-in tools that can be used by the AI.
8. **typings**: Type definitions for the project.
9. **.env**: Environment variables configuration.

This summary provides an overview of the functionality and purpose of each file in the `src` directory.
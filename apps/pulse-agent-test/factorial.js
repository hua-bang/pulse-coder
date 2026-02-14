/**
 * Calculates the factorial of a non-negative integer
 * @param {number} n - The number to calculate factorial for
 * @returns {number} - The factorial of n
 * @throws {Error} - If input is not a non-negative integer
 */
function factorial(n) {
    // Input validation
    if (typeof n !== 'number') {
        throw new Error('Input must be a number');
    }
    
    if (!Number.isInteger(n)) {
        throw new Error('Input must be an integer');
    }
    
    if (n < 0) {
        throw new Error('Input must be non-negative');
    }
    
    if (n > 170) {
        throw new Error('Input too large - would result in Infinity');
    }
    
    // Base cases
    if (n === 0 || n === 1) {
        return 1;
    }
    
    // Calculate factorial iteratively to avoid stack overflow
    let result = 1;
    for (let i = 2; i <= n; i++) {
        result *= i;
    }
    
    return result;
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = factorial;
}

// Example usage and testing
if (require.main === module) {
    console.log('Testing factorial function:');
    
    const testCases = [0, 1, 5, 10];
    testCases.forEach(n => {
        try {
            console.log(`${n}! = ${factorial(n)}`);
        } catch (error) {
            console.error(`Error for ${n}: ${error.message}`);
        }
    });
    
    // Test error cases
    const errorCases = [-1, 3.5, '5', null];
    errorCases.forEach(n => {
        try {
            console.log(`${n}! = ${factorial(n)}`);
        } catch (error) {
            console.error(`Expected error for ${n}: ${error.message}`);
        }
    });
}
import * as path from 'path';
import * as Mocha from 'mocha';
import * as fs from 'fs';

export function run(): Promise<void> {
	// Create the mocha test
	const mocha = new Mocha({
		ui: 'tdd',
		color: true
	});

	const testsRoot = path.resolve(__dirname, '..');

	return new Promise((c, e) => {
		// Simple file discovery without glob
		const suiteDir = path.join(testsRoot, 'suite');
		
		try {
			const files = fs.readdirSync(suiteDir);
			const testFiles = files.filter(f => f.endsWith('.test.js'));
			
			// Add files to the test suite
			testFiles.forEach(f => mocha.addFile(path.resolve(suiteDir, f)));

			// Run the mocha test
			mocha.run(failures => {
				if (failures > 0) {
					e(new Error(`${failures} tests failed.`));
				} else {
					c();
				}
			});
		} catch (err) {
			console.error(err);
			e(err);
		}
	});
}
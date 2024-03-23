import { CommandClasses } from "./CommandClasses";
import { parseNodeInformationFrame, parseNodeUpdatePayload } from "./NodeInfo";

describe("lib/node/NodeInfo", () => {
	describe("parseNodeInformationFrame()", () => {
		const payload = Buffer.from([
			0x01, // Remote Controller
			0x02, // Portable Scene Controller
			// Supported CCs
			CommandClasses["Multi Channel"],
			CommandClasses["Multilevel Toggle Switch"],
			0xef, // ======
			// Controlled CCs
			CommandClasses["Multilevel Toggle Switch"],
		]);
		const eif = parseNodeInformationFrame(payload);

		it("should extract the correct GenericDeviceClass", () => {
			expect(eif.generic).toBe(0x01);
		});

		it("should extract the correct SpecificDeviceClass", () => {
			expect(eif.specific).toBe(0x02);
		});

		it("should report the correct CCs as supported", () => {
			expect(eif.supportedCCs).toContainAllValues([
				CommandClasses["Multi Channel"],
				CommandClasses["Multilevel Toggle Switch"],
			]);
		});
	});

	describe("parseNodeUpdatePayload()", () => {
		const payload = Buffer.from([
			5, // NodeID
			7, // Length (is ignored)
			0x03, // Slave
			0x01, // Remote Controller
			0x02, // Portable Scene Controller
			// Supported CCs
			CommandClasses["Multi Channel"],
			CommandClasses["Multilevel Toggle Switch"],
			0xef, // ======
			// Controlled CCs
			CommandClasses["Multilevel Toggle Switch"],
		]);
		const nup = parseNodeUpdatePayload(payload);

		it("should extract the correct node ID", () => {
			expect(nup.nodeId).toBe(5);
		});

		it("should extract the correct BasicDeviceClass", () => {
			expect(nup.basic).toBe(3);
		});

		it("should extract the correct GenericDeviceClass", () => {
			expect(nup.generic).toBe(1);
		});

		it("should extract the correct SpecificDeviceClass", () => {
			expect(nup.specific).toBe(2);
		});

		it("should report the correct CCs as supported", () => {
			expect(nup.supportedCCs).toContainAllValues([
				CommandClasses["Multi Channel"],
				CommandClasses["Multilevel Toggle Switch"],
			]);
		});

		it("should report the correct CCs as controlled", () => {
			expect(nup.controlledCCs).toContainAllValues([
				CommandClasses["Multilevel Toggle Switch"],
			]);
		});

		it("correctly parses extended CCs", () => {
			const payload = Buffer.from([
				5, // NodeID
				7, // Length (is ignored)
				0x03,
				0x01,
				0x02, // Portable Scene Controller
				// Supported CCs
				// --> Security Mark
				0xf1,
				0x00,
				CommandClasses["Sensor Configuration"],
				// ====
				0xef,
				// ====
				// Controlled CCs
				CommandClasses.Supervision,
				// --> some hypothetical CC
				0xfe,
				0xdc,
			]);
			const nup = parseNodeUpdatePayload(payload);
			expect(nup.supportedCCs).toContainAllValues([
				CommandClasses["Security Mark"],
				CommandClasses["Sensor Configuration"],
			]);
			expect(nup.controlledCCs).toContainAllValues([
				0xfedc,
				CommandClasses.Supervision,
			]);
		});
	});
});

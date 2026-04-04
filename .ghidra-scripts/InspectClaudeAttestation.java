import java.util.ArrayList;
import java.util.List;

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;

public class InspectClaudeAttestation extends GhidraScript {

    private byte[] ascii(String s) {
        return s.getBytes();
    }

    private byte[] hex(String s) {
        int len = s.length();
        byte[] out = new byte[len / 2];
        for (int i = 0; i < len; i += 2) {
            out[i / 2] = (byte) Integer.parseInt(s.substring(i, i + 2), 16);
        }
        return out;
    }

    private List<Address> findAll(byte[] pattern) throws Exception {
        List<Address> matches = new ArrayList<>();
        Memory mem = currentProgram.getMemory();
        Address start = mem.getMinAddress();
        Address end = mem.getMaxAddress();
        while (true) {
            Address found = mem.findBytes(start, end, pattern, null, true, monitor);
            if (found == null) {
                break;
            }
            matches.add(found);
            start = found.add(pattern.length);
        }
        return matches;
    }

    private String blockName(Address addr) {
        MemoryBlock block = currentProgram.getMemory().getBlock(addr);
        if (block == null) {
            return "<no block>";
        }
        return block.getName();
    }

    @Override
    protected void run() throws Exception {
        println("PROGRAM: " + currentProgram.getExecutablePath());
        println("NAME: " + currentProgram.getName());

        Object[][] targets = new Object[][] {
            {"billing_header", ascii("x-anthropic-billing-header:")},
            {"cch_placeholder", ascii(" cch=00000;")},
            {"fingerprint_salt", ascii("59cf53e54c78")},
            {"seed_le", hex("1e8306c86a73526e")},
        };

        for (Object[] target : targets) {
            String label = (String) target[0];
            byte[] pattern = (byte[]) target[1];
            List<Address> matches = findAll(pattern);
            println("\nTARGET: " + label);
            println("MATCH_COUNT: " + matches.size());
            for (Address addr : matches) {
                println("  ADDR: " + addr + " BLOCK: " + blockName(addr));
            }
        }
    }
}

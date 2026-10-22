import type { ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

// Named handles keep forward and feedback paths apart: https://reactflow.dev/api-reference/components/handle
function WorkflowNode({ data, isConnectable }: NodeProps) {
  return (
    <>
      <Handle
        id="left"
        type="target"
        position={Position.Left}
        isConnectable={isConnectable}
      />
      {data.label as ReactNode}
      <Handle
        id="right"
        type="source"
        position={Position.Right}
        isConnectable={isConnectable}
      />
      <Handle
        id="bottom-source"
        type="source"
        position={Position.Bottom}
        style={{ left: '65%' }}
        isConnectable={isConnectable}
      />
      <Handle
        id="bottom-target"
        type="target"
        position={Position.Bottom}
        style={{ left: '35%' }}
        isConnectable={isConnectable}
      />
    </>
  );
}
export const workflowNodeTypes = { default: WorkflowNode };

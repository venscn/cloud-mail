import http from '@/axios/index.js'
import {createGatewayManagementApi} from './gateway-client.js'

export default createGatewayManagementApi(http)
